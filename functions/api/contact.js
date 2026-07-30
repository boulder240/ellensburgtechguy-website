/**
 * POST /api/contact
 *
 * Cloudflare Pages Function that receives the site's contact form and emails
 * it to Jacob via Resend.
 *
 * Required environment variable (Cloudflare Pages -> Settings -> Variables
 * and Secrets, added as an ENCRYPTED secret on the Production environment):
 *
 *   RESEND_API_KEY = re_xxxxxxxxxxxxxxxx
 *
 * Strongly recommended (also an ENCRYPTED secret):
 *
 *   TURNSTILE_SECRET_KEY = 0x4AAAAAAA...
 *
 * NOTE: Turnstile verification FAILS OPEN. If TURNSTILE_SECRET_KEY is not
 * set, submissions are accepted without a bot check rather than rejecting
 * every visitor. That is deliberate — a misconfigured secret should not take
 * the contact form offline. Check the Function logs for the warning if you
 * suspect the check isn't running.
 *
 * Optional plain-text overrides, only if you want to change the defaults:
 *
 *   CONTACT_TO    = Jacob@ellensburgtechguy.com
 *   CONTACT_FROM  = Ellensburg Tech Guy Website <noreply@ellensburgtechguy.com>
 */

const SUBJECT_PREFIX = "[Ellensburg Tech Guy]";
const DEFAULT_TO = "Jacob@ellensburgtechguy.com";
const DEFAULT_FROM =
  "Ellensburg Tech Guy Website <noreply@ellensburgtechguy.com>";

const MAX_LENGTHS = { name: 120, email: 200, message: 5000 };

const FALLBACK_ERROR =
  "Something went wrong sending your message. Please call or text 509-540-3176 and I'll get right back to you.";

export async function onRequestPost({ request, env }) {
  // The page's JavaScript posts JSON and renders the reply inline. If JS
  // never ran, the browser does a classic form-encoded POST instead — in
  // that case we redirect back to the page with ?sent / ?error so the
  // visitor sees a banner rather than a wall of raw JSON.
  const wantsJson = (request.headers.get("content-type") || "").includes(
    "application/json"
  );
  const respond = wantsJson ? json : redirect(request);

  try {
    const body = await readBody(request);

    // ---- Honeypot -------------------------------------------------------
    // The form has a hidden "company" field parked off-screen. Humans never
    // see it; bots fill in every field they find. If it has content, return
    // success so the bot doesn't retry with a different approach.
    if (typeof body.company === "string" && body.company.trim() !== "") {
      return respond({ ok: true });
    }

    // ---- Validation -----------------------------------------------------
    const name = clean(body.name, MAX_LENGTHS.name);
    const email = clean(body.email, MAX_LENGTHS.email);
    const message = clean(body.message, MAX_LENGTHS.message);

    const errors = [];
    if (!name) errors.push("Please enter your name.");
    if (!email) errors.push("Please enter your email address.");
    else if (!isEmail(email)) errors.push("That email address looks incomplete.");
    if (!message) errors.push("Please tell me what you need help with.");

    if (errors.length) return respond({ ok: false, error: errors.join(" ") }, 400);

    // ---- Bot check (Turnstile) ------------------------------------------
    // Runs AFTER field validation on purpose: a Turnstile token is single-use,
    // so a visitor with a typo in their email shouldn't burn theirs and have
    // to re-solve a challenge.
    const bot = await verifyTurnstile(request, env, body);
    if (!bot.ok) {
      return respond(
        {
          ok: false,
          error:
            "We couldn't verify you're human. Please refresh the page and try again, or call or text 509-540-3176.",
          retryable: true,
        },
        403
      );
    }

    // ---- Config check ---------------------------------------------------
    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) {
      console.error("contact: RESEND_API_KEY is not set");
      return respond({ ok: false, error: FALLBACK_ERROR }, 500);
    }

    const to = env.CONTACT_TO || DEFAULT_TO;
    const from = env.CONTACT_FROM || DEFAULT_FROM;

    // ---- Build the message ----------------------------------------------
    const subject = `${SUBJECT_PREFIX} New inquiry from ${name}`;
    const meta = collectMeta(request);

    const text = [
      "New message from the ellensburgtechguy.com contact form.",
      "",
      `Name:     ${name}`,
      `Email:    ${email}`,
      `Sent:     ${meta.timestamp}`,
      meta.location ? `Location: ${meta.location}` : null,
      "",
      "---",
      "",
      message,
      "",
      "---",
      `Reply directly to this email to respond to ${name}.`,
    ]
      .filter((line) => line !== null)
      .join("\n");

    // ---- Send via Resend -------------------------------------------------
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email, // lets you just hit Reply in Gmail
        subject,
        text,
        html: renderHtml({ name, email, message, meta }),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("contact: resend returned", res.status, detail);
      return respond({ ok: false, error: FALLBACK_ERROR }, 502);
    }

    return respond({ ok: true });
  } catch (err) {
    console.error("contact: unhandled error", err && err.stack ? err.stack : err);
    return respond({ ok: false, error: FALLBACK_ERROR }, 500);
  }
}

/**
 * Anything other than POST gets an explicit 405 rather than silently falling
 * through to the static site. That fall-through is exactly what made the old
 * broken form look like it had worked.
 */
export async function onRequest() {
  return new Response("Method not allowed. This endpoint accepts POST only.", {
    status: 405,
    headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" },
  });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function readBody(request) {
  const type = request.headers.get("content-type") || "";

  if (type.includes("application/json")) return await request.json();

  // Fallback: classic form-encoded POST. Keeps the form working even if the
  // page's JavaScript fails to load.
  const form = await request.formData();
  const out = {};
  for (const [key, value] of form.entries()) {
    out[key] = typeof value === "string" ? value : "";
  }
  return out;
}

/**
 * Validates the Cloudflare Turnstile token against the siteverify API.
 *
 * Fails OPEN when TURNSTILE_SECRET_KEY is absent: an unconfigured secret
 * should never take the contact form offline. Fails CLOSED on every other
 * path — missing token, rejected token, or siteverify being unreachable.
 */
async function verifyTurnstile(request, env, body) {
  const secret = env.TURNSTILE_SECRET_KEY;

  if (!secret) {
    console.warn(
      "contact: TURNSTILE_SECRET_KEY not set — accepting submission WITHOUT a bot check"
    );
    return { ok: true, skipped: true };
  }

  const token =
    body["cf-turnstile-response"] || body.turnstileToken || body.token;

  if (!token || typeof token !== "string") {
    console.warn("contact: submission had no Turnstile token");
    return { ok: false, reason: "missing-token" };
  }

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);

  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    );
    const data = await res.json();

    if (!data.success) {
      console.warn(
        "contact: Turnstile rejected token:",
        JSON.stringify(data["error-codes"] || [])
      );
      return { ok: false, reason: "rejected" };
    }

    return { ok: true };
  } catch (err) {
    console.error("contact: Turnstile siteverify unreachable", err);
    return { ok: false, reason: "siteverify-unreachable" };
  }
}

function clean(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function isEmail(value) {
  // Deliberately permissive. The real test is whether a reply bounces.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function collectMeta(request) {
  const cf = request.cf || {};
  const city = cf.city;
  const region = cf.region;

  return {
    timestamp: new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      dateStyle: "medium",
      timeStyle: "short",
    }),
    location: city && region ? `${city}, ${region}` : region || null,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHtml({ name, email, message, meta }) {
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");
  const safeLocation = meta.location ? escapeHtml(meta.location) : null;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e7e5e4">
      <div style="background:#1c1917;padding:16px 24px">
        <div style="color:#fbbf24;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:600">
          Website Contact Form
        </div>
      </div>
      <div style="padding:24px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr>
            <td style="padding:6px 0;color:#78716c;width:84px">Name</td>
            <td style="padding:6px 0;font-weight:600">${safeName}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#78716c">Email</td>
            <td style="padding:6px 0"><a href="mailto:${safeEmail}" style="color:#0d9488">${safeEmail}</a></td>
          </tr>
          ${
            safeLocation
              ? `<tr><td style="padding:6px 0;color:#78716c">Location</td><td style="padding:6px 0">${safeLocation}</td></tr>`
              : ""
          }
          <tr>
            <td style="padding:6px 0;color:#78716c">Sent</td>
            <td style="padding:6px 0">${escapeHtml(meta.timestamp)}</td>
          </tr>
        </table>

        <div style="margin:20px 0 0;padding:16px;background:#fafaf9;border-left:3px solid #fbbf24;border-radius:4px;font-size:15px;line-height:1.6">${safeMessage}</div>

        <p style="margin:20px 0 0;font-size:13px;color:#78716c">
          Reply to this email to respond to ${safeName} directly.
        </p>
      </div>
    </div>
  </body>
</html>`;
}

/**
 * Returns a responder that 303-redirects back to the contact section with a
 * ?sent or ?error flag, for no-JavaScript form posts.
 */
function redirect(request) {
  const origin = new URL(request.url).origin;
  return (data) => {
    const flag = data && data.ok ? "sent=1" : "error=1";
    return Response.redirect(`${origin}/?${flag}#contact`, 303);
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
