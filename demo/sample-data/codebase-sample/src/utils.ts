import { randomBytes } from "crypto";

/**
 * Convert a string into a URL-friendly slug.
 * "Hello World!" → "hello-world"
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * Format a Date (or ISO string) into a human-readable form.
 * Returns "Jan 15, 2025" style output.
 */
export function formatDate(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Basic email validation — checks for user@domain.tld pattern.
 */
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Generate a short, random identifier (12 hex characters).
 */
export function generateId(): string {
  return randomBytes(6).toString("hex");
}
