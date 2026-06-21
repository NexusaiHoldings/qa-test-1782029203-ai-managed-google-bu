/**
 * home-config — the company's root surface (company-root-landing-001).
 * Written by provisioning (_step_substrate_install) from CTO home_mode
 * + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeConfig {
  mode: "landing" | "conversation";
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "Your Google ranking is decaying while you're on the job \u2014 we fix it automatically, for $99/month.",
  "subhead": "The only fully autonomous, trade-specific Google Business Profile manager priced at $99/month \u2014 an AI agent posts weekly content, responds to every review in the owner's voice, and optimizes for service-area keywords with zero ongoing input"
};
