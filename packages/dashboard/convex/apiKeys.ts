import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const createApiKey = mutation({
  args: {
    orgId: v.string(),
    keyHash: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("apiKeys", {
      orgId: args.orgId,
      keyHash: args.keyHash,
      name: args.name,
      createdAt: Date.now(),
    });
  },
});

export const revokeApiKey = mutation({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .first();

    if (!key) throw new Error("API key not found");
    if (key.revokedAt) throw new Error("API key already revoked");

    await ctx.db.patch(key._id, { revokedAt: Date.now() });
  },
});

export const getOrgApiKeys = query({
  args: { orgId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("apiKeys")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();
  },
});

export const touchApiKey = mutation({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .first();

    if (!key || key.revokedAt) return;

    await ctx.db.patch(key._id, { lastUsedAt: Date.now() });
  },
});
