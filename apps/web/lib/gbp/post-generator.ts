export interface VoiceProfile {
  tone: string;
  keywords: string[];
  description: string;
}

export interface PostGenerationInput {
  businessName: string;
  voiceProfile: VoiceProfile;
  tradeCategory: string;
  seasonalContext: string;
  locationName: string;
}

export interface GeneratedPost {
  content: string;
  callToAction: string;
  hashtags: string[];
}

const GATEWAY_URL = process.env.AI_GATEWAY_URL ?? "https://api.openai.com/v1";

function buildPostPrompt(input: PostGenerationInput): string {
  const kw = input.voiceProfile.keywords.slice(0, 8).join(", ");
  return [
    `Business: ${input.businessName} (${input.locationName})`,
    `Trade category: ${input.tradeCategory}`,
    `Tone: ${input.voiceProfile.tone}`,
    `Business description: ${input.voiceProfile.description}`,
    `Seasonal context: ${input.seasonalContext}`,
    `Target keywords: ${kw}`,
    "",
    "Write a short Google Business Profile post (max 1500 chars) that fits this seasonal moment.",
    "Return ONLY valid JSON: { \"content\": string, \"callToAction\": string, \"hashtags\": string[] }",
    "callToAction must be one action phrase like 'Book your service today'.",
    "hashtags: 3-5 relevant short tags without the # symbol.",
  ].join("\n");
}

export async function generateGbpPost(input: PostGenerationInput): Promise<GeneratedPost> {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const response = await fetch(`${GATEWAY_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a concise local-business marketing writer. Output only the JSON object requested — no prose, no code fences.",
        },
        {
          role: "user",
          content: buildPostPrompt(input),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.75,
      max_tokens: 512,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI gateway ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const raw = data.choices[0]?.message?.content ?? "{}";

  let parsed: { content?: string; callToAction?: string; hashtags?: string[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`AI response was not valid JSON: ${raw.slice(0, 200)}`);
  }

  return {
    content: parsed.content ?? "",
    callToAction: parsed.callToAction ?? "Contact us today",
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
  };
}

const SEASONAL_CONTEXTS: Record<string, Record<number, string>> = {
  hvac: {
    1: "winter heating demand — furnace breakdowns and emergency heat calls peak now",
    2: "late-winter heating maintenance before spring thaw",
    3: "spring AC tune-up season — schedule before the summer rush",
    4: "pre-summer AC check — beat the heat preparation",
    5: "AC readiness season — ensure comfort before peak heat arrives",
    6: "summer cooling demand — AC maintenance and emergency repairs in high season",
    7: "peak summer cooling — high AC usage and potential system stress",
    8: "late-summer AC strain — prepare systems for the final heat push",
    9: "fall furnace check — heating season prep before temperatures drop",
    10: "heating season startup — furnace inspections and tune-ups",
    11: "pre-winter heating readiness — final chance before cold weather sets in",
    12: "winter heating protection — emergency service and energy efficiency",
  },
  plumbing: {
    1: "frozen pipe risk — emergency thaw and burst pipe repairs",
    2: "late-winter plumbing checks — prevent lingering freeze damage",
    3: "spring plumbing startup — outdoor faucets, irrigation, and sump pumps",
    4: "spring remodeling season — kitchen and bath upgrades in demand",
    5: "outdoor plumbing season — irrigation systems and hose bib installation",
    6: "summer water usage — pool filling, irrigation, and outdoor plumbing",
    7: "peak summer water demand — water heater efficiency and leak checks",
    8: "late-summer maintenance — water heater and drain health checks",
    9: "fall plumbing winterization — protecting outdoor pipes before frost",
    10: "pre-freeze pipe insulation — winterization services peak",
    11: "winter prep deadline — last call for outdoor plumbing protection",
    12: "holiday plumbing demand — garbage disposals, drain clogs, and guest-ready bathrooms",
  },
  electrical: {
    1: "winter electrical safety — space heater risks and overloaded circuits",
    2: "energy efficiency season — smart thermostats and LED upgrades",
    3: "spring safety audit — GFCI checks and panel inspections",
    4: "spring remodel season — wiring for additions and kitchen renovations",
    5: "outdoor electrical prep — landscape lighting and EV charger installs",
    6: "summer power demand — panel upgrades for AC and peak load management",
    7: "peak summer load — generator readiness and surge protection",
    8: "back-to-school season — home office wiring and charging station installs",
    9: "fall safety checks — smoke detectors, carbon monoxide detectors",
    10: "Halloween and holiday lighting — outdoor outlet and circuit needs",
    11: "holiday lighting season — dedicated circuits and safety inspections",
    12: "year-end safety audit — panel checks and code compliance reviews",
  },
};

const GENERIC_SEASONAL: Record<number, string> = {
  1: "winter home maintenance and safety inspections",
  2: "late-winter home protection and energy savings",
  3: "spring home readiness and pre-season tune-ups",
  4: "spring remodeling and home improvement season",
  5: "pre-summer preparation and outdoor service needs",
  6: "summer service demand — peak season scheduling",
  7: "peak summer maintenance and emergency service availability",
  8: "late-summer home checks and back-to-school readiness",
  9: "fall home preparation before colder weather arrives",
  10: "pre-winter maintenance and weatherization",
  11: "winter-ready home services and last-minute prep",
  12: "holiday season home care and year-end maintenance",
};

export function getSeasonalContext(month: number, tradeCategory: string): string {
  const normalized = tradeCategory.toLowerCase().replace(/\s+/g, "");
  const tradeMap = SEASONAL_CONTEXTS[normalized] ?? GENERIC_SEASONAL;
  return (tradeMap as Record<number, string>)[month] ?? GENERIC_SEASONAL[month] ?? "seasonal home service needs";
}
