import type { JSX } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { buildDb } from "@/lib/db";
import { scrapeWebsite } from "@/lib/gbp/website-scraper";
import {
  extractVoiceProfile,
  saveVoiceProfile,
  getVoiceProfile,
} from "@/lib/gbp/voice-extractor";
import type { VoiceProfile } from "@/lib/gbp/voice-extractor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function loadGbpConnection(userId: string): Promise<{
  id: string;
  description: string;
  reviewResponses: string[];
} | null> {
  const db = buildDb();
  try {
    const rows = await db.query<{
      id: string;
      description: string | null;
      review_responses: string[] | string | null;
    }>(
      `SELECT id, description, review_responses
         FROM gbp_connections
        WHERE user_id = $1
        LIMIT 1`,
      userId
    );
    if (!rows[0]) return null;
    const row = rows[0];
    let reviewResponses: string[] = [];
    if (Array.isArray(row.review_responses)) {
      reviewResponses = row.review_responses as string[];
    } else if (typeof row.review_responses === "string") {
      try {
        const parsed = JSON.parse(row.review_responses);
        reviewResponses = Array.isArray(parsed) ? parsed : [];
      } catch {
        reviewResponses = [];
      }
    }
    return {
      id: row.id,
      description: row.description ?? "",
      reviewResponses,
    };
  } catch {
    return null;
  }
}

async function handleExtract(formData: FormData): Promise<void> {
  "use server";

  const user = await getSessionUser();
  if (!user) redirect("/login");

  const gbpDescription = formData.get("gbp_description")?.toString().trim() ?? "";
  const websiteUrl = formData.get("website_url")?.toString().trim() ?? "";
  const reviewResponsesRaw =
    formData.get("review_responses")?.toString().trim() ?? "";

  const reviewResponses = reviewResponsesRaw
    .split(/\n---\n|\n\n/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  let websiteContent;
  if (websiteUrl) {
    websiteContent = await scrapeWebsite(websiteUrl);
  }

  const profile = await extractVoiceProfile({
    gbpDescription,
    websiteContent,
    reviewResponses,
  });

  await saveVoiceProfile(user.id, profile);
  redirect("/onboard/voice-setup?step=review");
}

async function handleSave(formData: FormData): Promise<void> {
  "use server";

  const user = await getSessionUser();
  if (!user) redirect("/login");

  const tone = formData.get("tone")?.toString().trim() ?? "professional";
  const formalityRaw = formData.get("formality")?.toString() ?? "professional";
  const validFormalities = new Set([
    "casual",
    "professional",
    "friendly",
    "formal",
    "authoritative",
  ]);
  const formality = validFormalities.has(formalityRaw)
    ? (formalityRaw as VoiceProfile["formality"])
    : "professional";

  const writingStyle =
    formData.get("writing_style")?.toString().trim() ?? "";

  const personality = (formData.get("personality")?.toString() ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const keyPhrases = (formData.get("key_phrases")?.toString() ?? "")
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  const avoidPhrases = (formData.get("avoid_phrases")?.toString() ?? "")
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  const exampleSentences = (formData.get("example_sentences")?.toString() ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const profile: VoiceProfile = {
    tone,
    formality,
    personality,
    writingStyle,
    keyPhrases,
    avoidPhrases,
    exampleSentences,
    extractedAt: new Date().toISOString(),
  };

  await saveVoiceProfile(user.id, profile);
  redirect("/onboarding?voice_setup=complete");
}

function ReviewForm({ profile }: { profile: VoiceProfile | null }): JSX.Element {
  const p = profile ?? {
    tone: "",
    formality: "professional" as VoiceProfile["formality"],
    personality: [] as string[],
    writingStyle: "",
    keyPhrases: [] as string[],
    avoidPhrases: [] as string[],
    exampleSentences: [] as string[],
    extractedAt: "",
  };

  return (
    <form action={handleSave}>
      <div className="card">
        <label>
          Overall Tone
          <input
            name="tone"
            defaultValue={p.tone}
            placeholder="e.g. warm and professional"
            required
          />
        </label>
        <label>
          Formality Level
          <select name="formality" defaultValue={p.formality}>
            <option value="casual">Casual</option>
            <option value="friendly">Friendly</option>
            <option value="professional">Professional</option>
            <option value="formal">Formal</option>
            <option value="authoritative">Authoritative</option>
          </select>
        </label>
        <label>
          Personality Traits
          <span className="muted"> (comma-separated)</span>
          <input
            name="personality"
            defaultValue={p.personality.join(", ")}
            placeholder="e.g. helpful, trustworthy, friendly"
          />
        </label>
        <label>
          Writing Style
          <textarea
            name="writing_style"
            defaultValue={p.writingStyle}
            placeholder="Describe how your brand communicates..."
            rows={3}
          />
        </label>
        <label>
          Key Phrases
          <span className="muted"> (one per line)</span>
          <textarea
            name="key_phrases"
            defaultValue={p.keyPhrases.join("\n")}
            placeholder="Phrases that reflect your brand voice..."
            rows={4}
          />
        </label>
        <label>
          Phrases to Avoid
          <span className="muted"> (one per line)</span>
          <textarea
            name="avoid_phrases"
            defaultValue={p.avoidPhrases.join("\n")}
            placeholder="Phrases that don't fit your brand..."
            rows={3}
          />
        </label>
        <label>
          Example Sentences
          <span className="muted"> (one per line)</span>
          <textarea
            name="example_sentences"
            defaultValue={p.exampleSentences.join("\n")}
            placeholder="Examples of how you write to customers..."
            rows={4}
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: "1rem", marginTop: "1rem" }}>
        <button type="submit">Save Voice Profile &amp; Continue</button>
        <a href="/onboard/voice-setup" className="btn secondary">
          Back to Setup
        </a>
      </div>
    </form>
  );
}

export default async function VoiceSetupPage({
  searchParams,
}: {
  searchParams: { step?: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const step = searchParams.step ?? "setup";

  if (step === "review") {
    const profile = await getVoiceProfile(user.id);

    return (
      <main>
        <h1>Review Your Brand Voice</h1>
        <p>
          We analyzed your content and extracted your brand voice profile. Review
          and refine it below — this shapes every post and review response we
          write for you.
        </p>
        <ReviewForm profile={profile} />
      </main>
    );
  }

  const gbpData = await loadGbpConnection(user.id);

  return (
    <main>
      <h1>Set Up Your Brand Voice</h1>
      <p>
        Answer three quick questions and we&apos;ll automatically extract your
        unique brand voice from your business content — keeping onboarding under
        10 minutes.
      </p>

      <form action={handleExtract}>
        <div className="card">
          <h2>1. Your Business Description</h2>
          <p className="muted">
            Auto-filled from your Google Business Profile. Edit to match how
            you&apos;d describe yourself to a new customer.
          </p>
          <textarea
            name="gbp_description"
            defaultValue={gbpData?.description ?? ""}
            placeholder="Describe your business: what you offer, who you serve, and what makes you unique..."
            rows={6}
            required
          />
        </div>

        <div className="card">
          <h2>2. Your Website</h2>
          <p className="muted">
            We&apos;ll analyze your website copy to understand your brand voice
            better. Leave blank if you don&apos;t have a website yet.
          </p>
          <input
            type="url"
            name="website_url"
            placeholder="https://yourbusiness.com"
          />
        </div>

        <div className="card">
          <h2>3. How You Talk to Customers</h2>
          <p className="muted">
            Examples of how you respond to reviews. Auto-filled from your recent
            Google review responses. Separate multiple examples with a blank line.
          </p>
          <textarea
            name="review_responses"
            defaultValue={
              gbpData?.reviewResponses.slice(0, 20).join("\n\n") ?? ""
            }
            placeholder={
              "Thank you for your kind review! We're so glad you enjoyed your experience with us.\n\n" +
              "We appreciate your feedback and look forward to serving you again soon."
            }
            rows={10}
          />
        </div>

        <button type="submit">Extract Voice Profile</button>
      </form>
    </main>
  );
}
