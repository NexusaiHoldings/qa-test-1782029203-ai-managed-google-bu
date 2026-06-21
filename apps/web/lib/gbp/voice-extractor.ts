import { buildDb } from "@/lib/db";
import { isScrapeError } from "./website-scraper";
import type { ScrapeResult } from "./website-scraper";

export interface VoiceProfile {
  tone: string;
  formality: "casual" | "professional" | "friendly" | "formal" | "authoritative";
  personality: string[];
  writingStyle: string;
  keyPhrases: string[];
  avoidPhrases: string[];
  exampleSentences: string[];
  extractedAt: string;
}

export interface ExtractVoiceProfileParams {
  gbpDescription?: string;
  websiteContent?: ScrapeResult;
  reviewResponses?: string[];
}

interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface AiResponse {
  choices: Array<{ message: { content: string } }>;
}

function buildContextText(params: ExtractVoiceProfileParams): string {
  const sections: string[] = [];

  if (params.gbpDescription?.trim()) {
    sections.push(`## Google Business Profile Description\n${params.gbpDescription.trim()}`);
  }

  if (params.websiteContent && !isScrapeError(params.websiteContent)) {
    const { title, description, bodyText } = params.websiteContent;
    const lines = [
      "## Website Content",
      title && `Title: ${title}`,
      description && `Meta description: ${description}`,
      bodyText && `Body:\n${bodyText.slice(0, 3000)}`,
    ].filter(Boolean) as string[];
    sections.push(lines.join("\n"));
  }

  if (params.reviewResponses && params.reviewResponses.length > 0) {
    const responses = params.reviewResponses
      .slice(0, 20)
      .map((r, i) => `Response ${i + 1}: ${r}`)
      .join("\n");
    sections.push(`## Owner Review Responses\n${responses}`);
  }

  return sections.join("\n\n");
}

function buildFallbackProfile(params: ExtractVoiceProfileParams): VoiceProfile {
  const desc = (params.gbpDescription ?? "").toLowerCase();
  let formality: VoiceProfile["formality"] = "professional";
  if (desc.includes("family") || desc.includes("friendly") || desc.includes("casual")) {
    formality = "friendly";
  } else if (
    desc.includes("luxury") ||
    desc.includes("premium") ||
    desc.includes("exclusive")
  ) {
    formality = "formal";
  } else if (
    desc.includes("expert") ||
    desc.includes("certified") ||
    desc.includes("specialist")
  ) {
    formality = "authoritative";
  }

  return {
    tone: "professional and customer-focused",
    formality,
    personality: ["reliable", "helpful", "experienced"],
    writingStyle:
      "Clear, direct communication with emphasis on customer satisfaction",
    keyPhrases: [],
    avoidPhrases: [],
    exampleSentences: params.reviewResponses?.slice(0, 3) ?? [],
    extractedAt: new Date().toISOString(),
  };
}

export async function extractVoiceProfile(
  params: ExtractVoiceProfileParams
): Promise<VoiceProfile> {
  const contextText = buildContextText(params);

  if (!contextText.trim()) {
    return buildFallbackProfile(params);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return buildFallbackProfile(params);
  }

  const apiBase =
    process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";

  const systemPrompt =
    `You are a brand voice analyst. Analyze the provided business content and extract a structured voice profile.\n` +
    `Respond ONLY with a valid JSON object using this exact schema:\n` +
    `{\n` +
    `  "tone": "string describing overall tone",\n` +
    `  "formality": "casual" | "professional" | "friendly" | "formal" | "authoritative",\n` +
    `  "personality": ["trait1", "trait2", "trait3"],\n` +
    `  "writingStyle": "string describing writing style",\n` +
    `  "keyPhrases": ["phrase1", ...up to 10],\n` +
    `  "avoidPhrases": ["phrase1", ...up to 5],\n` +
    `  "exampleSentences": ["example1", "example2", "example3"]\n` +
    `}`;

  const messages: AiMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Analyze this business content and extract the brand voice profile:\n\n${contextText}`,
    },
  ];

  const response = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages,
      response_format: { type: "json_object" },
      max_tokens: 1000,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    console.error(`[voice-extractor] AI API error ${response.status}: ${errBody}`);
    return buildFallbackProfile(params);
  }

  const data = (await response.json()) as AiResponse;
  const content = data.choices[0]?.message?.content ?? "{}";

  let parsed: Partial<VoiceProfile>;
  try {
    parsed = JSON.parse(content) as Partial<VoiceProfile>;
  } catch {
    console.error("[voice-extractor] Failed to parse AI response JSON");
    return buildFallbackProfile(params);
  }

  const validFormalities = new Set([
    "casual",
    "professional",
    "friendly",
    "formal",
    "authoritative",
  ]);
  const formality = validFormalities.has(parsed.formality ?? "")
    ? (parsed.formality as VoiceProfile["formality"])
    : "professional";

  return {
    tone: parsed.tone ?? "professional",
    formality,
    personality: Array.isArray(parsed.personality) ? parsed.personality : [],
    writingStyle: parsed.writingStyle ?? "",
    keyPhrases: Array.isArray(parsed.keyPhrases) ? parsed.keyPhrases : [],
    avoidPhrases: Array.isArray(parsed.avoidPhrases) ? parsed.avoidPhrases : [],
    exampleSentences: Array.isArray(parsed.exampleSentences)
      ? parsed.exampleSentences
      : [],
    extractedAt: new Date().toISOString(),
  };
}

export async function saveVoiceProfile(
  businessId: string,
  profile: VoiceProfile
): Promise<void> {
  const db = buildDb();

  await db.execute(
    `CREATE TABLE IF NOT EXISTS gbp_voice_profiles (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       business_id UUID NOT NULL UNIQUE,
       profile JSONB NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );

  await db.execute(
    `INSERT INTO gbp_voice_profiles (id, business_id, profile, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (business_id)
     DO UPDATE SET profile = $2::jsonb, updated_at = NOW()`,
    businessId,
    JSON.stringify(profile)
  );
}

export async function getVoiceProfile(
  businessId: string
): Promise<VoiceProfile | null> {
  const db = buildDb();
  try {
    const rows = await db.query<{ profile: VoiceProfile }>(
      `SELECT profile FROM gbp_voice_profiles WHERE business_id = $1 LIMIT 1`,
      businessId
    );
    return rows[0]?.profile ?? null;
  } catch {
    return null;
  }
}
