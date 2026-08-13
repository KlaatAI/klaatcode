/**
 * Plain-text receipt rendering. Pure presentation: every number printed
 * here comes straight off the invoice object, no re-computation.
 */

import { formatCents, formatPercent, padAmount } from "../money/format";
import type { Invoice } from "./invoice";

const WIDTH = 42;
const AMOUNT_COL = 12;

/** Render an invoice as a fixed-width text receipt. */
export function renderReceipt(invoice: Invoice): string {
  const out: string[] = [];
  out.push(center("RECEIPT", WIDTH));
  out.push(center(`Cart ${invoice.cartId} · ${invoice.jurisdiction}`, WIDTH));
  out.push("-".repeat(WIDTH));

  for (const line of invoice.lines) {
    const qty = line.quantity > 1 ? ` x${line.quantity}` : "";
    out.push(truncate(`${line.productName}${qty}`, WIDTH));
    const amount = formatCents(line.netCents, invoice.currency);
    const label =
      line.discountCodes.length > 0
        ? `  after ${line.discountCodes.join(",")}`
        : `  @ ${formatCents(line.unitPriceCents, invoice.currency)}`;
    out.push(row(label, amount));
    if (line.taxCents > 0) {
      out.push(
        row(`  tax ${formatPercent(line.taxRate * 100)}`, formatCents(line.taxCents, invoice.currency)),
      );
    }
  }

  out.push("-".repeat(WIDTH));
  out.push(row("Subtotal", formatCents(invoice.subtotalCents, invoice.currency)));
  out.push(row("Tax", formatCents(invoice.taxCents, invoice.currency)));
  out.push(row("TOTAL", formatCents(invoice.totalCents, invoice.currency)));
  return out.join("\n");
}

function row(label: string, amount: string): string {
  const labelWidth = WIDTH - AMOUNT_COL;
  const trimmed = truncate(label, labelWidth);
  return trimmed.padEnd(labelWidth, " ") + padAmount(amount, AMOUNT_COL);
}

function center(text: string, width: number): string {
  if (text.length >= width) return text;
  const left = Math.floor((width - text.length) / 2);
  return " ".repeat(left) + text;
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, width - 1) + "…";
}
