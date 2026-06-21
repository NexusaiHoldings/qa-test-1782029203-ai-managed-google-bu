export type SentimentLabel = "positive" | "neutral" | "negative";
export type ResponseQueue = "autonomous" | "human_review";

export interface SentimentResult {
  label: SentimentLabel;
  queue: ResponseQueue;
  toneGuidance: string;
  requiresHumanReview: boolean;
}

/**
 * Classify a review by star rating into a sentiment bucket.
 * 1-2 stars → negative → human_review queue (low confidence, reputational risk)
 * 3 stars   → neutral  → autonomous draft with empathetic tone
 * 4-5 stars → positive → autonomous draft + post
 */
export function classifyReview(rating: number): SentimentResult {
  if (rating >= 4) {
    return {
      label: "positive",
      queue: "autonomous",
      toneGuidance:
        "Express genuine gratitude and warmth. Reinforce what the customer appreciated. Keep it concise and friendly without being overly effusive.",
      requiresHumanReview: false,
    };
  }
  if (rating === 3) {
    return {
      label: "neutral",
      queue: "autonomous",
      toneGuidance:
        "Acknowledge the mixed experience with empathy. Thank them for honest feedback. Express a concrete commitment to improvement without being defensive or apologetic to a fault.",
      requiresHumanReview: false,
    };
  }
  // 1-2 stars
  return {
    label: "negative",
    queue: "human_review",
    toneGuidance:
      "Respond with a sincere apology and genuine empathy. Acknowledge the specific concern raised. Offer to make things right offline. Never be defensive or dismissive.",
    requiresHumanReview: true,
  };
}
