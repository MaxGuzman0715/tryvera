/**
 * Post finished résumés to a Telegram channel.
 *
 * Two credentials, and they answer different questions:
 *   TELEGRAM_BOT_TOKEN  — WHO is sending. Authenticates the bot; it is a password.
 *   TELEGRAM_CHAT_ID    — WHERE it goes. The channel id (negative, "-100…" prefix).
 *
 * The bot must be an administrator of that channel with "post messages", otherwise the
 * API answers 403 no matter how valid the token is.
 *
 * Everything here is best-effort: a send that fails must never fail the generation that
 * produced the documents. The files are already safely on disk by the time we get here.
 */

const API = "https://api.telegram.org";

export function telegramConfig(): { token: string; chatId: string } | null {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

export function isTelegramConfigured(): boolean {
  return telegramConfig() !== null;
}

/** Telegram caption limit. The JD text lives in the archive, not the message. */
const CAPTION_LIMIT = 1024;

export type TelegramJob = {
  companyName: string;
  roleName: string;
  jobLink: string;
  recruiterName: string;
  profiles: string[];
};

/** The message that travels with the archive. Plain text — no parse_mode, so nothing in a
 *  job title can break the formatting or be interpreted as markup. */
export function buildCaption(job: TelegramJob): string {
  const lines = [`${job.companyName} — ${job.roleName}`];
  const link = job.jobLink.trim();
  const rec = job.recruiterName.trim();
  if (link) lines.push(link);
  else if (rec) lines.push(`Recruiter: ${rec}`);
  if (job.profiles.length) lines.push(job.profiles.join(" · "));
  const caption = lines.join("\n");
  return caption.length > CAPTION_LIMIT ? caption.slice(0, CAPTION_LIMIT - 1) + "…" : caption;
}

export type TelegramResult = { ok: true; messageId?: number } | { ok: false; error: string };

/** Upload one archive with its caption. Resolves with an error rather than throwing. */
export async function sendDocument(
  filename: string,
  data: Buffer,
  caption: string,
  timeoutMs = 60_000
): Promise<TelegramResult> {
  const cfg = telegramConfig();
  if (!cfg) return { ok: false, error: "Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)." };

  const form = new FormData();
  form.append("chat_id", cfg.chatId);
  form.append("caption", caption);
  form.append(
    "document",
    new Blob([new Uint8Array(data)], { type: "application/zip" }),
    filename
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${cfg.token}/sendDocument`, {
      method: "POST",
      body: form,
      signal: ac.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    if (!res.ok || !body.ok) {
      // Never echo the token; `description` is Telegram's own explanation.
      return { ok: false, error: `HTTP ${res.status}: ${body.description ?? "unknown error"}` };
    }
    return { ok: true, messageId: body.result?.message_id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort/i.test(msg) ? `timed out after ${timeoutMs}ms` : msg };
  } finally {
    clearTimeout(timer);
  }
}
