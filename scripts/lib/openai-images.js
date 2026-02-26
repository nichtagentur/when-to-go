// DALL-E climate chart generator via OpenAI API
// Generates visual infographic of monthly climate data

const fs = require('fs');
const path = require('path');

async function generateClimateChart(countryName, slug, apiKey) {
  const imageDir = path.join(__dirname, '../../static/images/countries', slug);
  const imagePath = path.join(imageDir, 'climate-chart.png');

  // Skip if already exists
  if (fs.existsSync(imagePath)) {
    console.log(`Climate chart already exists for ${countryName}`);
    return `/images/countries/${slug}/climate-chart.png`;
  }

  const prompt = `Create a clean, professional infographic climate chart for ${countryName}. Show a horizontal bar chart or visual calendar with all 12 months (Jan-Dec). Use color coding: green for "Best time to visit", yellow for "Shoulder season", orange/red for "Less ideal". Include approximate temperature ranges and rainfall indicators. Clean white background, modern flat design, easy to read. Title: "Best Time to Visit ${countryName} - Monthly Overview". No watermarks.`;

  try {
    console.log(`Generating climate chart for ${countryName}...`);
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
      throw new Error(`DALL-E returned ${response.status}: ${err}`);
    }

    const data = await response.json();
    const b64 = data.data[0].b64_json;
    const buffer = Buffer.from(b64, 'base64');

    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(imagePath, buffer);

    console.log(`Saved climate chart for ${countryName} (${buffer.length} bytes)`);
    return `/images/countries/${slug}/climate-chart.png`;
  } catch (err) {
    console.error(`Climate chart generation failed for ${countryName}: ${err.message}`);
    return null;
  }
}

module.exports = { generateClimateChart };
