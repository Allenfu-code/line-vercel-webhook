// api/webhook.js
const line = require("@line/bot-sdk");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

module.exports = async (req, res) => {
  // LINE 會用 POST 打你的 webhook
  if (req.method !== "POST") {
    res.status(200).send("OK");
    return;
  }

  // 驗證簽名：如果 secret/token 沒設好，這裡會直接噴錯
  const signature = req.headers["x-line-signature"];
  const body = req.body;

  try {
    // Vercel 可能會把 body 解析成物件；需要原始字串來驗證時較麻煩
    // 最簡單做法：先暫時不驗證，確定通了再加強
    // 若你要立刻驗證，我可以給你「raw body」版本（需要調 vercel 設定）

    const events = body.events || [];
    await Promise.all(
      events.map(async (event) => {
        if (event.type !== "message") return;
        if (event.message.type !== "text") return;

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `收到：${event.message.text}`,
        });
      })
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};