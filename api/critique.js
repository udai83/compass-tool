// Vercel上で動作する、AIとの通信を専門に行うプログラム（発電所）です。

// 必要な部品をインポートします
import { GoogleGenerativeAI } from "@google/generative-ai";

// このファイル全体が、VercelによってAPIとして公開されます
export default async function handler(req, res) {
    console.log("★★ STEP 1: 発電所の処理が開始されました。★★");

    // POST以外のリクエストは受け付けません
    if (req.method !== 'POST') {
        console.error("エラー: POST以外のリクエストです。");
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log("★★ STEP 2: 魔法の呪文（APIキー）を取り出します。 ★★");
        // Vercelに設定した「魔法の呪文」を取り出します
        const API_KEY = process.env.GEMINI_API_KEY;
        if (!API_KEY) {
            console.error("重大なエラー: APIキーがVercelの環境変数に設定されていません。");
            throw new Error("APIキーがVercelの環境変数に設定されていません。");
        }
        console.log("★★ STEP 3: 魔法の呪文を無事に取り出しました。AIと通信準備をします。 ★★");
        
        // AIと通信するための準備をします
        const genAI = new GoogleGenerativeAI(API_KEY);
        // 必ずJSON形式で返事をくれるように、AIにお願いします
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest", generationConfig: { responseMimeType: "application/json" }});

        // お客様が入力したタイトルと本文を取り出します
        const { title, body } = req.body;
        if (!title || !body) {
            console.error("エラー: タイトルまたは本文が空です。");
            return res.status(400).json({ error: 'タイトルと本文の両方が必要です。' });
        }
        console.log("★★ STEP 4: お客様からの依頼を受け取りました。これからAIに指示を出します。 ★★");

        // AIに渡す、最強の指示書（プロンプト）です
        const prompt = `
あなたは、「ゴルフサプリ」の伝説的な編集長です。あなたの仕事は、ライターが執筆した記事を、LLMO（AI検索）時代に最も評価される最高のコンテンツに磨き上げることです。

以下の【LLMO重要ポイント】と【タイトル評価基準】に基づき、入力された記事のタイトルと本文を評価・添削してください。
採点は少しだけ優しく、改善を促すようなポジティブなフィードバックを心がけてください。

【LLMO重要ポイント】
1.  体験の具体性：書き手の個人的な体験談や、具体的な成功・失敗事例が含まれているか。
2.  独自性・一次情報：「ゴルフ実験室」のような、独自のデータや検証結果が含まれているか。
3.  構成の論理性：読者の悩みに寄り添い、疑問に先回りして答える構成になっているか。
4.  網羅性と回遊性：この記事を読み終えた読者が次に知りたくなる情報への言及や、内部リンクの機会があるか。

【タイトル評価基準】
1.  具体性：読者が「この記事に何が書かれているか」を具体的にイメージできるか。
2.  独自性・魅力：他の記事との差別化が図られ、クリックしたくなるような魅力があるか。
3.  キーワード：主要な検索キーワードが自然な形で含まれているか。

入力された記事は以下の通りです。
---
[タイトル]: ${title}
---
[本文]: ${body}
---

出力は、以下の厳格なJSON形式のみで行ってください。他のテキストは一切含めないでください。

{
  "title_feedback": {
    "score": 8,
    "comment": "具体的で分かりやすいですが、読者の興味を引くもう一工夫が欲しいところです。"
  },
  "overall_score": 7,
  "overall_comment": "内容は素晴らしいですが、プロの体験談を加えることで、さらに信頼性と独自性が増します。",
  "feedback_points": [
    {
      "point": "タイトルの改善案",
      "suggestion": "例：「【プロが体験談で語る】ドライバーが飛ばない3つの原因と、今日からできる即効ドリル」のように、誰が語るのか、どんな価値があるのかを明確にするとより魅力的になります。"
    },
    {
      "point": "体験の具体性",
      "suggestion": "「インサイドから下ろす意識」という部分を、プロ自身がスライスに悩んだ時の具体的なエピソードや、それを克服した際の練習法を交えて語ることはできますか？読者の共感を呼び、信頼性が格段に上がります。"
    },
    {
      "point": "独自性・一次情報",
      "suggestion": "もし可能であれば、「ヘッドスピード別に最適なクラブは？」といった、ゴルフサプリ独自の実験データを引用すると、他サイトにはない強力な武器になります。"
    },
    {
      "point": "構成と論理性",
      "suggestion": "全体的によくまとまっています。練習ドリルのセクションで、「なぜこのドリルが有効なのか？」という科学的な根拠やプロの解説を一行加えるだけで、より説得力が増します。"
    },
    {
      "point": "網羅性と内部リンク",
      "suggestion": "記事の最後に、「この記事で紹介したドリルと合わせて読みたい、おすすめのドライバー選びの記事」へのリンクを追加し、読者をサイト内で回遊させましょう。"
    }
  ]
}
`;
        // AIに指示書を渡して、返事を待ちます
        const result = await model.generateContent(prompt);
        const response = result.response;
        
        console.log("★★ STEP 5: AIから無事に返事がありました。お客様に結果をお届けします。 ★★");

        // AIからの返事を、お客様の画面に送れる形に整えます
        const responseData = JSON.parse(response.text());
        
        // 成功の返事を送ります
        res.status(200).json(responseData);

    } catch (error) {
        // もし途中で何か問題が起きたら、エラーの詳細を記録し、お客様に伝えます
        console.error('API Error:', error);
        res.status(500).json({ error: 'AIとの通信中にエラーが発生しました。詳細はサーバーログを確認してください。' });
    }
}

