// api/critique.js
// Vercel Serverless Function (Node.js) - ESM
// Handles two modes: text critique and URL critique (axios + cheerio)
// Uses Google Gemini via @google/generative-ai. API key from GEMINI_API_KEY.

import axios from "axios";
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---- Helpers ----
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        const parsed = data ? JSON.parse(data) : {};
        resolve(parsed);
      } catch (e) {
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

function extractArticle(html, url) {
  const $ = cheerio.load(html);

  // Title by H1
  const title = ($("h1").first().text() || $("title").first().text() || "").trim();

  // Prefer <article>, then <main>, else paragraph fallback
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

  // Remove nav/footer/aside obvious noise if present
  const noiseSelectors = ["header", "nav", "footer", "aside", ".sidebar", ".ads", ".advertisement"];
  noiseSelectors.forEach((sel) => $(sel).remove());

  return {
    title: title || "",
    body: body ? body.trim() : "",
  };
}

function buildPrompt({ title, body }) {
  // Inject the provided strict instruction (Japanese) into Gemini
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
  // Sometimes models wrap JSON in code fences. Extract the first JSON object.
  const match = text.match(/\{[\s\S]*\}$/m) || text.match(/\{[\s\S]*\}/m);
  if (!match) throw new Error("AIの応答からJSONを抽出できませんでした。");
  const raw = match[0];
  const parsed = JSON.parse(raw);
  return parsed;
}

// ---- Main Handler ----
export default async function handler(req, res) {
  // CORS (allow same origin; simple permissive for preview)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

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
      // Fetch and parse
      const htmlResp = await axios.get(targetUrl, {
        timeout: 20000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 COMPASS/1.0",
          Accept: "text/html,application/xhtml+xml",
        },
      });

      const { title: t, body: b } = extractArticle(htmlResp.data, targetUrl);
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
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "GEMINI_API_KEY が設定されていません。" });
    }
    const genAI = new GoogleGenerativeAI(apiKey);

    // ✅ 修正版：最新の正しいモデル指定
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });

    const prompt = buildPrompt({ title, body: content });

    const response = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 1024,
      },
    });

    const text = response?.response?.text?.() ?? "";
    if (!text) throw new Error("AIの応答が空でした。");

    let critique = extractJsonFromText(text);

    // Minimal schema validation / coercion
    try {
      if (critique?.title_feedback) {
        critique.title_feedback.score = parseInt(critique.title_feedback.score, 10);
        if (isNaN(critique.title_feedback.score)) critique.title_feedback.score = null;
      }
      critique.overall_score = parseInt(critique.overall_score, 10);
      if (isNaN(critique.overall_score)) critique.overall_score = null;
    } catch {}

    res.status(200).json({
      ok: true,
      critique,
      source: sourceMeta,
    });
  } catch (err) {
    console.error("[COMPASS] Error:", err);
    const message = err?.response?.status
      ? `外部サイト取得エラー (${err.response.status})`
      : err?.message || "不明なエラー";
    res.status(500).json({ ok: false, error: message });
  }
}
