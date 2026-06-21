import { classifyReview, type SentimentResult } from "./sentiment-classifier";

interface Db {
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  execute(sql: string, ...params: unknown[]): Promise<void>;
}

export interface VoiceProfile {
  tone: string;
  signOffName?: string;
  businessName?: string;
  keywords?: string[];
  exampleResponses?: string[];
}

export interface GbpConnection {
  id: string;
  locationId: string;
  accessToken: string;
  businessName: string;
  voiceProfile: VoiceProfile | null;
}

export interface ReviewRecord {
  id: string;
  connectionId: string;
  reviewName: string;
  reviewerName: string;
  rating: number;
  comment: string;
  status: string;
}

/**
 * Draft a review response using the business voice profile + sentiment tone guidance.
 * Calls the OpenAI chat completions endpoint via fetch (no SDK import).
 */
export async function draftReviewResponse(
  review: ReviewRecord,
  connection: GbpConnection,
  sentiment: SentimentResult,
): Promise<string> {
  const vp = connection.voiceProfile;
  const businessName = vp?.businessName ?? connection.businessName;
  const signOff = vp?.signOffName ?? "The Team";

  const voiceLines: string[] = [
    vp?.tone ? `Tone: ${vp.tone}` : "",
    `Sign-off name: ${signOff}`,
    vp?.keywords?.length ? `Brand keywords to naturally incorporate: ${vp.keywords.join(", ")}` : "",
    vp?.exampleResponses?.length
      ? `Example past responses for style reference:\n${vp.exampleResponses.slice(0, 2).join("\n---\n")}`
      : "",
  ].filter(Boolean);

  const systemPrompt = [
    `You are a professional responding to Google Business Profile reviews on behalf of ${businessName}.`,
    voiceLines.join("\n"),
    `Sentiment tone guidance: ${sentiment.toneGuidance}`,
    "Rules:",
    "- Write between 50 and 150 words",
    "- Be genuine and personalized, not generic or robotic",
    "- Match the business voice profile exactly",
    "- Never make false promises or fabricate specific details",
    "- Respond in the same language as the review",
    "- Do NOT include a subject line or greeting prefix — start the response directly",
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = `Write a professional review response for the following:
Reviewer name: ${review.reviewerName}
Star rating: ${review.rating}/5
Review text: ${review.comment.trim() || "(No text provided — rating only)"}

Output only the response body, nothing else.`;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not configured");
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 300,
      temperature: 0.7,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices[0]?.message?.content?.trim() ?? "";
  if (!content) {
    throw new Error("Empty response received from OpenAI");
  }
  return content;
}

/**
 * Post a reply to an existing GBP review via the Google My Business API.
 */
export async function postReviewResponse(
  reviewName: string,
  responseText: string,
  accessToken: string,
): Promise<void> {
  const url = `https://mybusiness.googleapis.com/v4/${reviewName}/reply`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ comment: responseText }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`GBP reply API error ${resp.status}: ${errText.slice(0, 300)}`);
  }
}

/**
 * Full pipeline: load review + connection, classify sentiment, draft and optionally
 * post the response. 1-2 star reviews are routed to the human_review queue instead.
 */
export async function processReview(
  db: Db,
  reviewId: string,
): Promise<{ posted: boolean; queued: boolean; error?: string }> {
  type ReviewRow = {
    id: string;
    connection_id: string;
    review_name: string;
    reviewer_name: string;
    rating: number;
    comment: string | null;
    status: string;
    location_id: string;
    access_token: string;
    business_name: string;
    voice_profile: VoiceProfile | null;
  };

  const rows = await db.query<ReviewRow>(
    `SELECT r.id, r.connection_id, r.review_name, r.reviewer_name, r.rating,
            r.comment, r.status,
            c.location_id, c.access_token, c.business_name, c.voice_profile
     FROM gbp_reviews r
     JOIN gbp_connections c ON c.id = r.connection_id
     WHERE r.id = $1`,
    reviewId,
  );

  if (rows.length === 0) {
    return { posted: false, queued: false, error: "review_not_found" };
  }

  const row = rows[0];
  const review: ReviewRecord = {
    id: row.id,
    connectionId: row.connection_id,
    reviewName: row.review_name,
    reviewerName: row.reviewer_name,
    rating: row.rating,
    comment: row.comment ?? "",
    status: row.status,
  };
  const connection: GbpConnection = {
    id: row.connection_id,
    locationId: row.location_id,
    accessToken: row.access_token,
    businessName: row.business_name,
    voiceProfile: row.voice_profile ?? null,
  };

  const sentiment = classifyReview(review.rating);

  if (sentiment.requiresHumanReview) {
    await db.execute(
      `UPDATE gbp_reviews SET status = 'human_review', sentiment = $1 WHERE id = $2`,
      sentiment.label,
      review.id,
    );
    return { posted: false, queued: true };
  }

  let draftText: string;
  try {
    draftText = await draftReviewResponse(review, connection, sentiment);
  } catch (err) {
    await db.execute(
      `UPDATE gbp_reviews SET status = 'draft_failed', sentiment = $1 WHERE id = $2`,
      sentiment.label,
      review.id,
    );
    return { posted: false, queued: false, error: String(err) };
  }

  try {
    await postReviewResponse(review.reviewName, draftText, connection.accessToken);
  } catch (err) {
    await db.execute(
      `UPDATE gbp_reviews
       SET status = 'post_failed', sentiment = $1, response_text = $2
       WHERE id = $3`,
      sentiment.label,
      draftText,
      review.id,
    );
    return { posted: false, queued: false, error: String(err) };
  }

  await db.execute(
    `UPDATE gbp_reviews
     SET status = 'posted', sentiment = $1, response_text = $2, response_posted_at = NOW()
     WHERE id = $3`,
    sentiment.label,
    draftText,
    review.id,
  );
  return { posted: true, queued: false };
}
