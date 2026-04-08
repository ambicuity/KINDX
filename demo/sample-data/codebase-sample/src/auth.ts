import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const TOKEN_EXPIRY = "24h";

export interface AuthPayload {
  userId: string;
  email: string;
  role: "admin" | "user";
}

export interface AuthRequest extends Request {
  user?: AuthPayload;
}

/**
 * Generate a signed JWT for the given user payload.
 */
export function generateToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

/**
 * Verify and decode a JWT. Throws if the token is invalid or expired.
 */
export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

/**
 * Express middleware that requires a valid Bearer token.
 * Attaches the decoded user to `req.user`.
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed authorization header" });
    return;
  }

  try {
    const token = header.slice(7);
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Login handler — validates credentials and returns a JWT.
 */
export async function login(email: string, password: string): Promise<string | null> {
  // In production this would query the database
  const user = await lookupUser(email, password);
  if (!user) return null;
  return generateToken({ userId: user.id, email: user.email, role: user.role });
}

/**
 * Placeholder credential lookup — replace with real DB call.
 */
async function lookupUser(email: string, _password: string) {
  // Stub: accept any non-empty password for demo purposes
  if (!email || !_password) return null;
  return { id: "usr_001", email, role: "user" as const };
}
