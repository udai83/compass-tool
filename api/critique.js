// api/critique.js
// Vercel Serverless Function (Node.js) - ESM
// - mode=text:  タイトル＋本文をGeminiで添削
// - mode=url :  axios+cheerioでh1/本文を抽出してGeminiで添削
// Gemini APIキーは Vercel 環境変数 GEMINI_API_KEY から取得

import axios from "axios";
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------- Helpers ----------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sanitizeText(s, max = 8000) {
  if (!s) return "";
  const t = s.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? t.slice(0, max) + "\n…(省略)" : t;
}

function extractArticle(html) {
  const $ = cheerio.load(html);

  // 先にノイズっぽい領域を除去（簡易）
  ["header", "nav", "footer", "aside", ".sidebar", ".ads", ".advertisement"].forEach((sel) =>
    $(sel).remove()
  );

  const title =
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content") ||
    $("title").first().text().trim() ||
    "";

  let body = "";
  if ($("article").length) {
    body = $("article").first().text();
  } else if ($("main").length) {
    body = $("main").first().text();
  } else {
    const parts = [];
    $("p").each((_, el) => {
      const txt = $(el).text().trim();
      if (txt) parts.push(txt);
    });
    body = parts.join("\n\n");
  }

  return { title: title || "", body: (body || "").trim() };
}

function buildPrompt({ title, body }) {
  return `
あなたは、「ゴルフサプリ」の伝説的な編集長です。あなたの仕事は、ライターが執筆した記事を、LLMO（AI検索）時代に最も評価される最高のコンテンツに磨き上げることです。

以下の【LLMO重要ポイント】と【タイトル評価基準】に基づき、入力された記事のタイトルと本文を評価・添削してください。
採点は少しだけ優しく、改善を促すようなポジティブなフィードバックを心がけてください。

【LLMO重要ポイント】

体験の具体性：書き手の個人的な体験談や、具体的な成功・失敗事例が含まれているか。

独自性・一次情報：「ゴルフ実験室」のような、独自のデータや検証結果が含まれているか。

構成の論理性：読者の悩みに寄り添い、疑問に先回りして答える構成になっているか。

網羅性と回遊性：この記事を読み終えた読者が次に知りたくなる情報への言及や、内部リンクの機会があるか。

【タイトル評価基準】

具体性：読者が「この記事に何が書かれているか」を具体的にイメージできるか。

独自性・魅力：他の記事との差別化が図られ、クリックしたくなるような魅力があるか。

キーワード：主要な検索キーワードが自然な形で含まれているか。

入力された記事は以下の通りです。

---
【タイトル】
${title || "(未入力)"}

【本文】
${body || "(未入力)"}
---

出力は、以下の厳格なJSON形式のみで行ってください。他のテキストは一切含めないでください。

{
"title_feedback": {
"score": (1から10の整数),
"comment": "(タイトルへの具体的な評価コメント)"
},
"overall_score": (1から10の整数),
"overall_comment": "(記事全体への具体的な総評)",
"feedback_points": [
{
"point": "タイトルの改善案",
"suggestion": "(SEOと魅力を両立する、具体的なタイトル改善案を提示)"
},
{
"point": "体験の具体性",
"suggestion": "(記事のどの部分に、どのような体験談を追加すべきか具体的に提案)"
},
{
"point": "独自性・一次情報",
"suggestion": "(記事のどの部分に、どのような独自データを追加すると価値が上がるか具体的に提案)"
},
{
"point": "構成と論理性",
"suggestion": "(読者の理解を深めるための、具体的な構成の改善点を指摘)"
},
{
"point": "網羅性と内部リンク",
"suggestion": "(この記事から次に繋げるべき、具体的な内部リンク先や追記すべきトピックを提案)"
}
]
}
`.trim();
}

function extractJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}$/m) || text.match(/\{[\s\S]*\}/m);
  if (!match) throw new Error("AIの応答からJSONを抽出できませんでした。");
  return JSON.parse(match[0]);
}

function isModelNotFoundOrUnsupported(err) {
  const msg = String(err?.message || "");
  return (
    msg.includes("404") ||
    msg.toLowerCase().includes("not found") ||
    msg.toLowerCase().includes("is not supported for generatecontent")
  );
}

// 指定した順にモデルを試す（環境差異/版差異に対応）
async function generateWithFallback(genAI, prompt) {
  const candidateModels = [
    "gemini-1.5-pro-002",
    "gemini-1.5-pro",
    "gemini-1.5-flash-002",
    "gemini-1.5-flash",
    "gemini-1.0-pro"
  ];

  const tried = [];
  let lastError;

  for (const m of candidateModels) {
    try {
      const model = genAI.getGenerativeModel({ model: m });
      const resp = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1024
        }
      });
      const out = resp?.response?.text?.() ?? resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (!out) throw new Error("AIの応答が空でした。");
      return { text: out, model: m };
    } catch (err) {
      tried.push(m);
      lastError = err;
      if (!isModelNotFoundOrUnsupported(err)) {
        // 404/未対応以外は即座に打ち切り（APIキー不正・レート等）
        throw new Error(`${err.message || err}`);
      }
      // 404/未対応 → 次の候補へ
    }
  }

  throw new Error(
    `利用可能なモデルが見つかりませんでした。試行モデル: ${tried.join(", ")} / 最後のエラー: ${lastError?.message || lastError}`
  );
}

// ---------- Main Handler ----------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const body = await readJsonBody(req);
    const mode = body?.mode;

    let title = "";
    let content = "";
    let sourceMeta = { mode: "text" };

    if (mode === "url") {
      const targetUrl = String(body?.url || "");
      if (!/^https?:\/\//i.test(targetUrl)) {
        return res.status(400).json({ ok: false, error: "URLが不正です。" });
      }

      const htmlResp = await axios.get(targetUrl, {
        timeout: 20000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 COMPASS/1.0",
          Accept: "text/html,application/xhtml+xml"
        }
      });

      const { title: t, body: b } = extractArticle(htmlResp.data);
      title = sanitizeText(t || "");
      content = sanitizeText(b || "");
      sourceMeta = { mode: "url", url: targetUrl, title };

      if (!title && !content) {
        return res.status(422).json({ ok: false, error: "指定URLから本文を抽出できませんでした。" });
      }
    } else if (mode === "text") {
      title = sanitizeText(String(body?.title || ""));
      content = sanitizeText(String(body?.body || ""));
      if (!title || !content) {
        return res.status(400).json({ ok: false, error: "タイトルと本文は必須です。" });
      }
    } else {
      return res.status(400).json({ ok: false, error: "mode は 'text' または 'url' を指定してください。" });
    }

    // Gemini
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "GEMINI_API_KEY が設定されていません。" });

    const genAI = new GoogleGenerativeAI(apiKey);
    const prompt = buildPrompt({ title, body: content });

    // ★ モデル自動フォールバック
    const { text } = await generateWithFallback(genAI, prompt);

    const critique = extractJsonFromText(text);

    // 形式の軽い整形
    try {
      if (critique?.title_feedback) {
        critique.title_feedback.score = parseInt(critique.title_feedback.score, 10);
        if (isNaN(critique.title_feedback.score)) critique.title_feedback.score = null;
      }
      critique.overall_score = parseInt(critique.overall_score, 10);
      if (isNaN(critique.overall_score)) critique.overall_score = null;
    } catch {}

    return res.status(200).json({ ok: true, critique, source: sourceMeta });
  } catch (err) {
    console.error("[COMPASS] Error:", err);
    const message =
      err?.response?.status
        ? `外部サイト取得エラー (${err.response.status})`
        : err?.message || "不明なエラー";
    return res.status(500).json({ ok: false, error: message });
  }
}
