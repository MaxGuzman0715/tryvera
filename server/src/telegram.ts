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

/**
 * Escape for Telegram's HTML parse mode.
 *
 * Everything interpolated goes through this, including the URL: real postings carry query
 * strings full of `&` (…&jr_id=…&token=…), and an unescaped one makes Telegram reject the
 * whole message. Telegram decodes the entities, so the link a reader clicks is the original.
 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The message that travels with the archive.
 *
 * Telegram has no arbitrary text colour, so recognisability comes from emoji plus bold —
 * the channel is scanned at a glance, and the company name is what people look for.
 */
export function buildCaption(job: TelegramJob): string {
  const lines = [`📄 <b>${esc(job.companyName)}</b>`, `💼 ${esc(job.roleName)}`];
  const link = job.jobLink.trim();
  const rec = job.recruiterName.trim();
  if (link) lines.push(`🔗 ${esc(link)}`);
  // Keep the word: an emoji plus a bare name does not say who the person is.
  else if (rec) lines.push(`🙋 Recruiter: ${esc(rec)}`);
  if (job.profiles.length) lines.push(`👥 ${esc(job.profiles.join(" · "))}`);
  const caption = lines.join("\n");
  // Truncating could cut a tag in half and make Telegram reject the message, so drop whole
  // lines from the end instead until it fits.
  if (caption.length <= CAPTION_LIMIT) return caption;
  const kept = [...lines];
  while (kept.length > 1 && kept.join("\n").length > CAPTION_LIMIT) kept.pop();
  const out = kept.join("\n");
  return out.length <= CAPTION_LIMIT ? out : `📄 <b>${esc(job.companyName.slice(0, 200))}</b>`;
}

export type TelegramResult = { ok: true; messageId?: number } | { ok: false; error: string };

export type OutgoingFile = { filename: string; data: Buffer; mime: string };

/** Telegram caps a media group at 10 items. */
const MEDIA_GROUP_MAX = 10;

/**
 * Post several files as ONE grouped message, with the caption on the first item.
 *
 * Preferred over a ZIP: the recipient gets the résumés as plain PDFs they can open or
 * forward directly. Fifty batches a day would otherwise mean fifty unzips.
 *
 * Falls back to sendDocument when there is a single file, since a one-item media group is
 * rejected by the API.
 */
export async function sendFiles(
  files: OutgoingFile[],
  caption: string,
  timeoutMs = 120_000
): Promise<TelegramResult> {
  const cfg = telegramConfig();
  if (!cfg) return { ok: false, error: "Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)." };
  if (files.length === 0) return { ok: false, error: "nothing to send" };
  if (files.length === 1) return sendDocument(files[0]!.filename, files[0]!.data, caption, timeoutMs);
  if (files.length > MEDIA_GROUP_MAX) {
    return { ok: false, error: `too many files for one message (${files.length} > ${MEDIA_GROUP_MAX})` };
  }

  const form = new FormData();
  form.append("chat_id", cfg.chatId);
  // Each item references its upload by an `attach://` name.
  const media = files.map((f, i) => ({
    type: "document" as const,
    media: `attach://f${i}`,
    ...(i === 0 ? { caption, parse_mode: "HTML" as const } : {}),
  }));
  form.append("media", JSON.stringify(media));
  files.forEach((f, i) => {
    form.append(`f${i}`, new Blob([new Uint8Array(f.data)], { type: f.mime }), f.filename);
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${cfg.token}/sendMediaGroup`, {
      method: "POST",
      body: form,
      signal: ac.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number }[];
    };
    if (!res.ok || !body.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${body.description ?? "unknown error"}` };
    }
    return { ok: true, messageId: body.result?.[0]?.message_id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort/i.test(msg) ? `timed out after ${timeoutMs}ms` : msg };
  } finally {
    clearTimeout(timer);
  }
}

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
  // buildCaption emits HTML and escapes everything it interpolates.
  form.append("parse_mode", "HTML");
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
