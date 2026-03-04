import { mutation, query, httpAction } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

export const joinWaitlist = mutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase().trim();

    const existing = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    if (existing) {
      return { status: "already_registered", id: existing._id };
    }

    const id = await ctx.db.insert("waitlist", {
      email,
      createdAt: Date.now(),
      source: args.source ?? "website",
    });

    return { status: "registered", id };
  },
});

export const getWaitlistCount = query({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db.query("waitlist").collect();
    return entries.length;
  },
});

export const listWaitlist = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("waitlist")
      .withIndex("by_createdAt")
      .order("desc")
      .take(args.limit ?? 100);
  },
});

// HTTP Action for landing page form
export const handleWaitlistSignup = httpAction(async (ctx, request) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers,
    });
  }

  let body: { email?: string; source?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers,
    });
  }

  const email = body?.email?.trim();
  if (!email || !email.includes("@")) {
    return new Response(JSON.stringify({ error: "Invalid email address" }), {
      status: 400,
      headers,
    });
  }

  const result = await ctx.runMutation(api.waitlist.joinWaitlist, {
    email,
    source: body.source ?? "landing",
  });

  return new Response(JSON.stringify(result), { status: 200, headers });
});
