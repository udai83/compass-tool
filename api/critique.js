// api/critique.js
// Vercel Serverless Function (Node.js/ESM)
// - mode=text:  タイトル＋本文を評価
// - mode=url :  axios+cheerioで抽出したh1/本文を評価
// Google Gemini (Generative Language API) を REST で直接呼び出す。
// APIキーは Vercel 環境変数 GEMINI_API_KEY を使用。

import axios from "axios";
import * as cheerio from "cheerio";

// ---------------- Utilities ----------------
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

// ---------------- Gemini REST ----------------
// 1) ListModels で、このAPIキーが使えるモデルを取得
async function listModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    apiKey
  )}`;
  const resp = await axios.get(url, { timeout: 15000 });
  return resp.data?.models || [];
}

// 2) generateContent をサポートするモデルの中から優先順で選択
function pickBestModel(models) {
  // supportedGenerationMethods に "generateContent" を含むものだけ
  const usable = models.filter((m) =>
    (m.supportedGenerationMethods || []).includes("generateContent")
  );

  // 優先順。存在する最初のものを使う
  const preferred = [
    "gemini-1.5-pro-002",
    "gemini-1.5-pro",
    "gemini-1.5-flash-002",
    "gemini-1.5-flash",
    "gemini-1.0-pro",
    "gemini-pro"
  ];

  for (const name of preferred) {
    const found = usable.find((m) => m.name === name || m.name?.endsWith(`/models/${name}`));
    if (found) return found.name.includes("/models/") ? found.name.split("/models/")[1] : found.name;
  }

  // 何もマッチしなければ、usableの先頭を返す（最後の保険）
  if (usable.length > 0) {
    const n = usable[0].name;
    return n.includes("/models/") ? n.split("/models/")[1] : n;
  }

  return null;
}

// 3) 選択したモデルで generateContent 実行（REST）
async function generateContentREST(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1024
    }
  };
  const resp = await axios.post(url, payload, { timeout: 30000 });
  // レスポンスからテキスト抽出
  const txt =
    resp.data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("") || "";
  if (!txt) throw new Error("AIの応答が空でした。");
  return txt;
}

// ---------------- Main Handler ----------------
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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "GEMINI_API_KEY が設定されていません。" });

    // まず、このキーで使えるモデル一覧を取得し、generateContent対応モデルを自動選択
    const models = await listModels(apiKey);
    const chosen = pickBestModel(models);
    if (!chosen) {
      return res.status(500).json({
        ok: false,
        error:
          "このAPIキーで利用可能な generateContent 対応モデルが見つかりませんでした。AI Studioのキーか、Generative Language APIが有効化されたGoogle CloudのAPIキーを使用してください。"
      });
    }

    const prompt = buildPrompt({ title, body: content });
    const text = await generateContentREST(apiKey, chosen, prompt);
    const critique = extractJsonFromText(text);

    // 軽い整形
    try {
      if (critique?.title_feedback) {
        critique.title_feedback.score = parseInt(critique.title_feedback.score, 10);
        if (isNaN(critique.title_feedback.score)) critique.title_feedback.score = null;
      }
      critique.overall_score = parseInt(critique.overall_score, 10);
      if (isNaN(critique.overall_score)) critique.overall_score = null;
    } catch {}

    return res.status(200).json({ ok: true, critique, source: sourceMeta, used_model: chosen });
  } catch (err) {
    console.error("[COMPASS] Error:", err?.response?.data || err);
    const message =
      err?.response?.data?.error?.message ||
      (err?.response?.status ? `外部サイト取得エラー (${err.response.status})` : err?.message) ||
      "不明なエラー";
    return res.status(500).json({ ok: false, error: message });
  }
}
