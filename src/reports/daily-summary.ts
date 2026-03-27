import { getDb, getManualQueue, closeDb } from '../db.js';
import { CHECKS, DAILY_QUOTA } from '../config.js';

interface DailySummary {
  subject: string;
  textBody: string;
  htmlBody: string;
}

/**
 * Generates the "Hey Mark" daily summary for console and email.
 */
export function generateDailySummary(mode: 'morning' | 'followup' | 'catchup' = 'morning'): DailySummary {
  const db = getDb();

  // Stats
  const totalPages = (db.prepare('SELECT COUNT(*) as c FROM pages WHERE active = 1').get() as any).c;
  const totalAudited = (db.prepare(`
    SELECT COUNT(DISTINCT page_id) as c FROM audit_results
    WHERE run_id NOT IN ('excel-import', 'excel-auditdb-import')
  `).get() as any).c;
  const pct = totalPages > 0 ? ((totalAudited / totalPages) * 100).toFixed(1) : '0.0';

  // Last activity
  const lastResult = db.prepare(`
    SELECT ar.audit_date, p.page_name, ar.check_name
    FROM audit_results ar JOIN pages p ON p.id = ar.page_id
    WHERE ar.audited_by != 'excel-import' AND ar.audited_by != 'excel-auditdb'
    ORDER BY ar.audit_date DESC LIMIT 1
  `).get() as { audit_date: string; page_name: string; check_name: string } | undefined;

  // Manual queue
  const pendingItems = getManualQueue(db) as any[];
  const todayItems = pendingItems.slice(0, DAILY_QUOTA);
  const bonusItems = pendingItems.slice(DAILY_QUOTA, DAILY_QUOTA + 5);

  // Yesterday's progress
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const yesterdayProgress = db.prepare('SELECT * FROM daily_progress WHERE date = ?').get(yesterdayStr) as any;

  // Unscanned pages
  const unscanned = (db.prepare(`
    SELECT COUNT(*) as c FROM pages p WHERE p.active = 1
    AND NOT EXISTS (
      SELECT 1 FROM audit_results ar WHERE ar.page_id = p.id
      AND ar.run_id NOT IN ('excel-import', 'excel-auditdb-import')
    )
  `).get() as any).c;

  // Schedule check
  const schedule = db.prepare('SELECT * FROM schedule WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get() as any;

  // Build the text
  let text = '';
  let html = '';

  if (mode === 'morning') {
    text += `Hey Mark — let's knock out ${Math.min(DAILY_QUOTA, pendingItems.length)} pages today!\n\n`;
    html += `<h2 style="color:#1a56db;">Hey Mark — let's knock out ${Math.min(DAILY_QUOTA, pendingItems.length)} pages today!</h2>`;
  } else if (mode === 'followup') {
    text += `Nice work! Want to get ahead? Here are some bonus pages:\n\n`;
    html += `<h2 style="color:#16a34a;">Nice work! Want to get ahead?</h2>`;
  } else {
    text += `Let's catch up — here's where things stand:\n\n`;
    html += `<h2 style="color:#d97706;">Let's catch up — here's where things stand</h2>`;
  }

  // HOW TO START
  text += `HOW TO START RIGHT NOW:\n`;
  text += `  1. Open terminal\n`;
  text += `  2. Type: dwa\n`;
  text += `  3. Type: npm run today\n`;
  text += `  That's it — Claude will walk you through the rest.\n\n`;
  html += `<div style="background:#e8f0fe;border-left:4px solid #1a56db;padding:1em;margin:1em 0;border-radius:0 6px 6px 0;">`;
  html += `<strong>HOW TO START RIGHT NOW:</strong><br>`;
  html += `1. Open terminal<br>2. Type: <code>dwa</code><br>3. Type: <code>npm run today</code><br>`;
  html += `That's it — Claude will walk you through the rest.</div>`;

  // WHERE YOU LEFT OFF
  text += `WHERE YOU LEFT OFF:\n`;
  html += `<h3>Where You Left Off</h3>`;
  if (lastResult) {
    text += `  Last activity: ${lastResult.audit_date}\n`;
    text += `  Last page: ${lastResult.page_name} (${lastResult.check_name})\n`;
    html += `<p>Last activity: ${lastResult.audit_date}<br>Last page: <strong>${lastResult.page_name}</strong> (${lastResult.check_name})</p>`;
  }
  text += `  Queue remaining: ${pendingItems.length} items\n\n`;
  html += `<p>Queue remaining: <strong>${pendingItems.length}</strong> items</p>`;

  // Yesterday's progress
  if (yesterdayProgress) {
    text += `YESTERDAY'S PROGRESS:\n`;
    text += `  Pages scanned: ${yesterdayProgress.pages_auto}\n`;
    text += `  Manual reviews done: ${yesterdayProgress.manual_done}\n\n`;
    html += `<h3>Yesterday's Progress</h3>`;
    html += `<p>Pages scanned: ${yesterdayProgress.pages_auto} | Manual reviews: ${yesterdayProgress.manual_done}</p>`;
  }

  // Unscanned pages alert
  if (unscanned > 0) {
    text += `⚠ ${unscanned} pages haven't been auto-scanned yet.\n`;
    text += `  Run: npm run audit --new --limit 50\n\n`;
    html += `<div style="background:#fef3c7;border-left:4px solid #d97706;padding:0.75em 1em;margin:1em 0;border-radius:0 6px 6px 0;">`;
    html += `<strong>${unscanned} pages</strong> haven't been auto-scanned yet. Run: <code>npm run audit --new --limit 50</code></div>`;
  }

  // Today's items
  const items = mode === 'followup' ? bonusItems : todayItems;
  if (items.length > 0) {
    const label = mode === 'followup' ? 'BONUS PAGES' : "TODAY'S MANUAL REVIEWS";
    text += `${label} (${items.length} items):\n\n`;
    html += `<h3>${label} (${items.length} items)</h3><table style="border-collapse:collapse;width:100%;"><tr style="background:#1a56db;color:white;"><th style="padding:0.5em;text-align:left;">Page</th><th style="padding:0.5em;text-align:left;">Check</th><th style="padding:0.5em;text-align:left;">Command</th></tr>`;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const checkInfo = CHECKS.find(c => c.number === item.check_number);
      text += `  Page ${i + 1}: ${item.page_name}\n`;
      text += `    Open: ${item.url}\n`;
      text += `    Check: ${checkInfo?.name || item.check_number}\n`;
      text += `    Command: npm run review -- ${item.page_id} ${item.check_number} pass "description"\n\n`;
      html += `<tr style="background:${i % 2 === 0 ? '#f9fafb' : 'white'};"><td style="padding:0.5em;border:1px solid #e5e7eb;"><a href="${item.url}">${item.page_name}</a></td><td style="padding:0.5em;border:1px solid #e5e7eb;">${checkInfo?.name}</td><td style="padding:0.5em;border:1px solid #e5e7eb;"><code>npm run review -- ${item.page_id} ${item.check_number} pass "desc"</code></td></tr>`;
    }
    html += `</table>`;
  }

  // Overall progress
  text += `OVERALL: ${totalAudited}/${totalPages} pages scanned (${pct}%)\n`;
  html += `<div style="background:white;border:2px solid #1a56db;padding:1em;border-radius:8px;margin-top:1.5em;text-align:center;">`;
  html += `<strong style="color:#1a56db;font-size:1.3em;">${totalAudited}/${totalPages}</strong> pages scanned (${pct}%)</div>`;

  const subject = mode === 'morning'
    ? `DOJ Audit: Let's knock out ${Math.min(DAILY_QUOTA, pendingItems.length)} pages today`
    : mode === 'followup'
    ? `DOJ Audit: Want to get ahead? ${bonusItems.length} bonus pages ready`
    : `DOJ Audit: Catch-up time — ${pendingItems.length} items in queue`;

  closeDb();

  return {
    subject,
    textBody: text,
    htmlBody: `<!DOCTYPE html><html><body style="font-family:'Segoe UI',sans-serif;max-width:700px;margin:2em auto;padding:0 1em;color:#222;">${html}</body></html>`,
  };
}

/**
 * Sends the daily summary via email using nodemailer (if configured).
 */
export async function sendDailyEmail(mode: 'morning' | 'followup' | 'catchup' = 'morning'): Promise<void> {
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;
  const emailTo = process.env.EMAIL_TO;

  if (!emailUser || !emailPass || !emailTo) {
    console.log('Email not configured. Set EMAIL_USER, EMAIL_PASS, EMAIL_TO in .env');
    console.log('Printing to console instead:\n');
    const summary = generateDailySummary(mode);
    console.log(summary.textBody);
    return;
  }

  // Dynamic import to avoid requiring nodemailer for non-email use
  try {
    const nodemailer = await import('nodemailer');
    const summary = generateDailySummary(mode);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailUser, pass: emailPass },
    });

    await transporter.sendMail({
      from: emailUser,
      to: emailTo,
      subject: summary.subject,
      text: summary.textBody,
      html: summary.htmlBody,
    });

    console.log(`Email sent to ${emailTo}: ${summary.subject}`);
  } catch (err) {
    console.log(`Email failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log('Install nodemailer for email support: npm install nodemailer');
    const summary = generateDailySummary(mode);
    console.log('\nFalling back to console output:\n');
    console.log(summary.textBody);
  }
}
