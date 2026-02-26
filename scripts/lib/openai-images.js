// Climate chart generator using Gemini Nano Banana (image generation)
// Falls back to DALL-E if Gemini fails and OPENAI_API_KEY is available

const fs = require('fs');
const path = require('path');

async function generateClimateChart(countryName, slug, openaiApiKey) {
  const imageDir = path.join(__dirname, '../../static/images/countries', slug);
  const imagePath = path.join(imageDir, 'climate-chart.png');

  // Skip if already exists
  if (fs.existsSync(imagePath)) {
    console.log(`Climate chart already exists for ${countryName}`);
    return `/images/countries/${slug}/climate-chart.png`;
  }

  // Try Gemini first
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const result = await tryGeminiChart(countryName, slug, geminiKey, imageDir, imagePath);
    if (result) return result;
  }

  // Fallback to DALL-E
  if (openaiApiKey) {
    const result = await tryDalleChart(countryName, slug, openaiApiKey, imageDir, imagePath);
    if (result) return result;
  }

  console.warn(`Could not generate climate chart for ${countryName}`);
  return null;
}

async function tryGeminiChart(countryName, slug, apiKey, imageDir, imagePath) {
  try {
    console.log(`Gemini Nano Banana: generating climate chart for ${countryName}...`);

    const prompt = `Create a clean, professional infographic climate chart for ${countryName}. Show all 12 months (Jan through Dec) in a horizontal layout. Use color coding: bright green for "Best time to visit", warm yellow for "Shoulder season", soft coral/red for "Less ideal". Include approximate temperature ranges (Celsius) and rainfall indicators for each month. Clean white background, modern flat design with rounded elements, easy to read at a glance. Title at top: "Best Time to Visit ${countryName}". Subtitle: "Monthly Climate Overview". Use a professional sans-serif font. No watermarks, no decorative borders. Make it look like a high-quality travel magazine infographic.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini returned ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const candidates = data.candidates || [];

    for (const candidate of candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
          const buffer = Buffer.from(part.inlineData.data, 'base64');
          fs.mkdirSync(imageDir, { recursive: true });
          fs.writeFileSync(imagePath, buffer);

          console.log(`Saved Gemini climate chart for ${countryName} (${buffer.length} bytes)`);
          return `/images/countries/${slug}/climate-chart.png`;
        }
      }
    }

    throw new Error('No image found in Gemini response');
  } catch (err) {
    console.error(`Gemini chart generation failed for ${countryName}: ${err.message}`);
    return null;
  }
}

async function tryDalleChart(countryName, slug, apiKey, imageDir, imagePath) {
  const prompt = `Create a clean, professional infographic climate chart for ${countryName}. Show a horizontal bar chart or visual calendar with all 12 months (Jan-Dec). Use color coding: green for "Best time to visit", yellow for "Shoulder season", orange/red for "Less ideal". Include approximate temperature ranges and rainfall indicators. Clean white background, modern flat design, easy to read. Title: "Best Time to Visit ${countryName} - Monthly Overview". No watermarks.`;

  try {
    console.log(`DALL-E: generating climate chart for ${countryName}...`);
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: '1792x1024',
        quality: 'standard',
        response_format: 'b64_json',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`DALL-E returned ${response.status}: ${err.substring(0, 200)}`);
    }

    const data = await response.json();
    const b64 = data.data[0].b64_json;
    const buffer = Buffer.from(b64, 'base64');

    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(imagePath, buffer);

    console.log(`Saved DALL-E climate chart for ${countryName} (${buffer.length} bytes)`);
    return `/images/countries/${slug}/climate-chart.png`;
  } catch (err) {
    console.error(`DALL-E chart generation failed for ${countryName}: ${err.message}`);
    return null;
  }
}

module.exports = { generateClimateChart };
