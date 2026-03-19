const MISTRAL_API_URL = "https://api.mistral.ai/v1/embeddings";
const BATCH_SIZE = 20;
const MAX_RETRIES = 3;

function getApiKey(): string {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error("Missing MISTRAL_API_KEY in .env");
  return key;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callEmbeddingApi(texts: string[]): Promise<number[][]> {
  const apiKey = getApiKey();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(MISTRAL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "codestral-embed",
        input: texts,
      }),
    });

    if (response.status === 429) {
      const waitMs = Math.pow(2, attempt) * 1000;
      console.error(`Rate limited, waiting ${waitMs}ms...`);
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Mistral API error ${response.status}: ${body}`);
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to preserve input order
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  throw new Error("Mistral API: max retries exceeded");
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await callEmbeddingApi(batch);
    results.push(...embeddings);
  }

  return results;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await callEmbeddingApi([text]);
  return embedding;
}
