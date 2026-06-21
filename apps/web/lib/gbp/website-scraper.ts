export interface ScrapedContent {
  title: string;
  description: string;
  bodyText: string;
}

export interface ScrapeError {
  error: string;
  url: string;
}

export type ScrapeResult = ScrapedContent | ScrapeError;

export function isScrapeError(result: ScrapeResult): result is ScrapeError {
  return "error" in result;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaContent(html: string, name: string): string {
  const nameFirst = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const contentFirst = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,
    "i"
  );
  return (html.match(nameFirst) ?? html.match(contentFirst))?.[1] ?? "";
}

function extractTitle(html: string): string {
  return html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "";
}

function extractBodyText(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch?.[1] ?? html;
  const parts: string[] = [];

  const headings = body.match(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi) ?? [];
  for (const tag of headings) {
    const txt = stripHtml(tag).trim();
    if (txt) parts.push(txt);
  }

  const paragraphs = body.match(/<p[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  for (const tag of paragraphs) {
    const txt = stripHtml(tag).trim();
    if (txt.length > 20) parts.push(txt);
  }

  const listItems = body.match(/<li[^>]*>[\s\S]*?<\/li>/gi) ?? [];
  for (const tag of listItems.slice(0, 30)) {
    const txt = stripHtml(tag).trim();
    if (txt.length > 10) parts.push(txt);
  }

  return parts.join("\n").slice(0, 8000);
}

export async function scrapeWebsite(url: string): Promise<ScrapeResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url.startsWith("http") ? url : `https://${url}`);
  } catch {
    return { error: "Invalid URL format", url };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(parsedUrl.toString(), {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; VoiceProfileBot/1.0; +https://gbp.example.com/bot)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        error: `HTTP ${response.status}: ${response.statusText}`,
        url: parsedUrl.toString(),
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      return { error: "URL does not return HTML content", url: parsedUrl.toString() };
    }

    const html = await response.text();
    const title = extractTitle(html);
    const description =
      extractMetaContent(html, "description") ||
      extractMetaContent(html, "og:description");
    const bodyText = extractBodyText(html);

    return { title, description, bodyText };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      return { error: "Request timed out after 15 seconds", url: parsedUrl.toString() };
    }
    return {
      error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      url: parsedUrl.toString(),
    };
  }
}
