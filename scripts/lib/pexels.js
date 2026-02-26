// Hero image generator using Gemini Nano Banana (image generation)
// Uses the Gemini API with gemini-2.5-flash-image for image generation
// Falls back to Unsplash source URLs if Gemini fails

const fs = require('fs');
const path = require('path');

async function fetchHeroImage(countryName, slug, geminiApiKey) {
  const imageDir = path.join(__dirname, '../../static/images/countries', slug);
  const imagePath = path.join(imageDir, 'hero.png');

  // Skip if already exists
  if (fs.existsSync(imagePath)) {
    console.log(`Hero image already exists for ${countryName}`);
    return {
      path: `/images/countries/${slug}/hero.png`,
      credit: 'AI-generated',
      alt: `${countryName} landscape - travel destination`,
    };
  }

  // Try Gemini Nano Banana image generation
  if (geminiApiKey) {
    const result = await tryGeminiImage(countryName, slug, geminiApiKey, imageDir, imagePath);
    if (result) return result;
  }

  // Fallback: Unsplash source URL (no API key needed)
  const result = await tryUnsplash(countryName, slug, imageDir, imagePath);
  if (result) return result;

  console.warn(`No hero image found for ${countryName}`);
  return null;
}

async function tryGeminiImage(countryName, slug, apiKey, imageDir, imagePath) {
  try {
    console.log(`Gemini Nano Banana: generating hero image for ${countryName}...`);

    const prompt = `Generate a stunning, cinematic landscape photograph of ${countryName}. Show an iconic, breathtaking view that captures the essence of this country -- famous landmarks, natural beauty, or cultural scenery. Wide-angle, golden hour lighting, vibrant but natural colors, magazine cover quality. Photorealistic style, 16:9 aspect ratio.`;

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

    // Find the image part in the response
    const candidates = data.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
          const buffer = Buffer.from(part.inlineData.data, 'base64');
          fs.mkdirSync(imageDir, { recursive: true });
          fs.writeFileSync(imagePath, buffer);

          console.log(`Saved Gemini hero image for ${countryName} (${buffer.length} bytes)`);
          return {
            path: `/images/countries/${slug}/hero.png`,
            credit: 'AI-generated via Gemini',
            alt: `${countryName} landscape - travel destination`,
          };
        }
      }
    }

    throw new Error('No image found in Gemini response');
  } catch (err) {
    console.error(`Gemini image generation failed for ${countryName}: ${err.message}`);
    return null;
  }
}

async function tryUnsplash(countryName, slug, imageDir, imagePath) {
  const searchTerms = [
    `${countryName} landscape`,
    `${countryName} travel`,
    `${countryName}`,
  ];

  for (const query of searchTerms) {
    try {
      console.log(`Unsplash fallback: fetching "${query}"...`);
      const url = `https://source.unsplash.com/1600x900/?${encodeURIComponent(query)}`;

      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`Unsplash returned ${response.status}`);

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('image')) throw new Error('Not an image');

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 10000) continue;

      fs.mkdirSync(imageDir, { recursive: true });
      fs.writeFileSync(imagePath, buffer);

      console.log(`Saved Unsplash hero for ${countryName} (${buffer.length} bytes)`);
      return {
        path: `/images/countries/${slug}/hero.png`,
        credit: 'Photo via Unsplash',
        alt: `${countryName} landscape - travel destination`,
      };
    } catch (err) {
      console.error(`Unsplash "${query}" failed: ${err.message}`);
    }
  }
  return null;
}

module.exports = { fetchHeroImage };
