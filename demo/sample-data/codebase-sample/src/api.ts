import { Router, Request, Response } from "express";
import { requireAuth, AuthRequest, login, generateToken } from "./auth";
import { db } from "./db";
import { slugify, generateId, validateEmail } from "./utils";

const router = Router();

// ── Auth Routes ──────────────────────────────────────────────────────

router.post("/auth/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  if (!validateEmail(email)) {
    return res.status(400).json({ error: "Invalid email format" });
  }
  const token = await login(email, password);
  if (!token) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  res.json({ token });
});

router.post("/auth/logout", requireAuth, (_req: AuthRequest, res: Response) => {
  // In a full implementation this would blacklist the token
  res.json({ message: "Logged out successfully" });
});

// ── User Routes ──────────────────────────────────────────────────────

router.get("/users", requireAuth, async (_req: AuthRequest, res: Response) => {
  const users = await db.query("SELECT id, email, name, created_at FROM users");
  res.json({ users });
});

router.get("/users/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const user = await db.query("SELECT id, email, name, created_at FROM users WHERE id = ?", [req.params.id]);
  if (!user.length) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({ user: user[0] });
});

router.put("/users/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, email } = req.body;
  await db.update("users", req.params.id, { name, email });
  res.json({ message: "User updated" });
});

// ── Product Routes ───────────────────────────────────────────────────

router.get("/products", async (_req: Request, res: Response) => {
  const products = await db.query("SELECT * FROM products WHERE active = 1");
  res.json({ products });
});

router.get("/products/:slug", async (req: Request, res: Response) => {
  const product = await db.query("SELECT * FROM products WHERE slug = ?", [req.params.slug]);
  if (!product.length) {
    return res.status(404).json({ error: "Product not found" });
  }
  res.json({ product: product[0] });
});

router.post("/products", requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, description, price } = req.body;
  if (!name || price == null) {
    return res.status(400).json({ error: "Name and price are required" });
  }
  const id = generateId();
  const slug = slugify(name);
  await db.insert("products", { id, name, slug, description, price, active: 1 });
  res.status(201).json({ id, slug });
});

router.delete("/products/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  await db.update("products", req.params.id, { active: 0 });
  res.json({ message: "Product deactivated" });
});

// ── Health Check ─────────────────────────────────────────────────────

router.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default router;
