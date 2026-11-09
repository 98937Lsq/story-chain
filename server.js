import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const API_BASE = process.env.API_BASE;
const API_KEY  = process.env.API_KEY;
const MODEL    = process.env.MODEL || 'deepseek-chat';

function buildSystemPrompt(maxRounds, round) {
  return `你是陪小学三四年级学生玩"故事接龙"的AI小伙伴。

【你最核心的任务】
小朋友刚说了一句话，你必须紧接着这句话往下写，不许另起炉灶。
具体做法：
- 如果小朋友的话里有一个主角（比如"小狐狸"），你的回复里必须出现这个主角，或者主角刚才遇到的"那个东西"。
- 如果小朋友描述了一个动作（比如"走进森林"），你就写这个动作直接导致的结果。
- 如果小朋友说了对话，就让另一个角色回应。
- 如果小朋友说遇到了麻烦，你就给出转机或帮手。
- 你的第一句话，必须能直接接在他那句后面，读起来像一段连续的对话。

【语言要求】
- 只写 1~2 句，40~70 个汉字，像讲给 9 岁孩子听。
- 不要提问、不要总结、不要解释。
- 只有在最后一轮（第 ${maxRounds} 轮）时，用一句温暖的话收尾。

【本轮信息】
这是第 ${round} 轮，共 ${maxRounds} 轮。

只输出 JSON，不要任何其他文字：
{
  "understood": ["小朋友最后一句话里的关键名词1", "关键名词2"],
  "reply": "你接的故事句子"
}`;
}

app.post('/api/continue', async (req, res) => {
  const { opening, history = [], round = 1, maxRounds = 3 } = req.body || {};

  if (!opening || !Array.isArray(history)) {
    return res.status(400).json({ error: '参数不完整' });
  }

  // 找到小朋友最后说的那句话
  const lastKidIndex = history.map(h => h.role).lastIndexOf('kid');
  const lastKidText = lastKidIndex >= 0 ? history[lastKidIndex].text : '';
  const historyBefore = lastKidIndex >= 0 ? history.slice(0, lastKidIndex) : history;

  // 拼对话：开头 → 之前的历史 → 明确指明"小朋友刚说了什么"
  const messages = [
    { role: 'system', content: buildSystemPrompt(maxRounds, round) },
    { role: 'user', content: `【故事开头】${opening}` },
    ...historyBefore.map(h => ({
      role: h.role === 'ai' ? 'assistant' : 'user',
      content: h.text
    })),
    {
      role: 'user',
      content: `小朋友刚刚说的这一句是：「${lastKidText}」\n\n请接着这句话，用 1~2 句往下编。回复里必须出现他这句话里的关键名词。只输出 JSON。`
    }
  ];

  try {
    const r = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.8,
        max_tokens: 300,
        response_format: { type: 'json_object' }
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('模型报错:', r.status, errText);
      return res.status(502).json({ error: '模型调用失败' });
    }

    const data = await r.json();
    const raw = data.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }

    const reply = String(parsed?.reply || '').trim();
    if (!reply) return res.status(502).json({ error: '模型返回为空' });

    const understood = Array.isArray(parsed?.understood)
      ? parsed.understood.map(String).filter(Boolean).slice(0, 3)
      : [];

    res.json({ reply, understood });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器异常' });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`✅ 服务已启动: http://localhost:${process.env.PORT || 3000}`);
});