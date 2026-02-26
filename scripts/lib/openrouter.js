// OpenRouter API wrapper with 3-model fallback chain
// Models: Gemini Flash (cheapest) -> DeepSeek -> GPT-4o-mini

const MODELS = [
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini Flash' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o-mini' },
];

async function generateContent(prompt, apiKey) {
  let lastError = null;

  for (const model of MODELS) {
    try {
      console.log(`Trying ${model.name}...`);
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://nichtagentur.github.io/when-to-go/',
          'X-Title': 'When To Go Travel Blog',
        },
        body: JSON.stringify({
          model: model.id,
          messages: [
            { role: 'system', content: 'You are Elena Vasquez, a senior travel editor with 15 years of experience visiting 80+ countries. You write authoritative, SEO-optimized travel guides. Always write in a warm but professional tone.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 8000,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`${model.name} returned ${response.status}: ${err}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content || content.length < 500) {
        throw new Error(`${model.name} returned insufficient content (${content?.length || 0} chars)`);
      }

      console.log(`Success with ${model.name} (${content.length} chars)`);
      return { content, model: model.name };
    } catch (err) {
      console.error(`${model.name} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw new Error(`All models failed. Last error: ${lastError.message}`);
}

module.exports = { generateContent };
