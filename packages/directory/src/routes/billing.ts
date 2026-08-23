/**
 * Stripe billing routes for product plans.
 *
 * Billing and identity assurance are deliberately independent: paying for a
 * plan must never grant a verification badge or raise an identity tier.
 * Requires: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET env vars
 * Optional: STRIPE_PRICE_PRO, STRIPE_PRICE_BUSINESS, STRIPE_PRICE_ENTERPRISE
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Database } from 'better-sqlite3'
import Stripe from 'stripe'
import { getAgent } from '../db.js'
import { agentApiKeyMatches, getSuppliedApiKey } from '../api-key.js'
import { BEAM_ID_RE } from '../validation.js'

type DB = Database

// Price IDs can be overridden via env vars, or created dynamically
const PLAN_AMOUNTS = {
  pro: 900,          // €9/year in cents
  business: 4900,    // €49/year
  enterprise: 19900, // €199/year
} as const

const PLAN_NAMES: Record<string, string> = {
  pro: 'Beam Pro',
  business: 'Beam Business',
  enterprise: 'Beam Enterprise',
}

interface BillingRow {
  id: number
  beam_id: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  tier: string
  status: string
  current_period_end: string | null
  created_at: string
}

export function billingRouter(db: DB, stripeClient?: Stripe) {
  const app = new Hono()

  // Lazy-init Stripe
  let _stripe: Stripe | null = stripeClient ?? null
  function getStripe(): Stripe {
    if (_stripe) return _stripe
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured')
    _stripe = new Stripe(key)
    return _stripe
  }

  function requireAgentApiKey(c: Context, beamId: string): Response | null {
    const agent = getAgent(db, beamId)
    if (!agent) {
      return c.json({ error: 'Agent not found', errorCode: 'NOT_FOUND' }, 404)
    }

    return agentApiKeyMatches(agent, getSuppliedApiKey(c.req.raw))
      ? null
      : c.json({ error: 'Missing or invalid API key', errorCode: 'UNAUTHORIZED' }, 401)
  }

  function normalizePlan(value: unknown): keyof typeof PLAN_AMOUNTS | null {
    // `verified` was the legacy paid tier. Preserve checkout compatibility,
    // but map it to a product plan without changing identity assurance.
    const normalized = String(value ?? '').trim().toLowerCase()
    if (normalized === 'verified') return 'pro'
    return normalized in PLAN_AMOUNTS ? normalized as keyof typeof PLAN_AMOUNTS : null
  }

  function safeReturnUrl(value: unknown, fallback: string, appUrl: string): string {
    if (typeof value !== 'string' || !value.trim()) return fallback

    try {
      const base = new URL(appUrl)
      const candidate = new URL(value, base)
      const allowedOrigins = new Set([
        base.origin,
        ...(process.env['BILLING_RETURN_ORIGINS'] ?? '')
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ])
      return candidate.protocol === 'https:' && allowedOrigins.has(candidate.origin)
        ? candidate.toString()
        : fallback
    } catch {
      return fallback
    }
  }

  /**
   * POST /billing/checkout
   * Creates a Stripe Checkout Session for a product plan.
   * Body: { beamId: string, plan: 'pro'|'business'|'enterprise', successUrl?: string, cancelUrl?: string }
   */
  app.post('/checkout', async (c) => {
    const body = await c.req.json<{
      beamId: string
      plan?: string
      tier?: string
      successUrl?: string
      cancelUrl?: string
    }>()

    if (!body.beamId || !BEAM_ID_RE.test(body.beamId)) {
      return c.json({ error: 'Invalid beamId' }, 400)
    }
    const plan = normalizePlan(body.plan ?? body.tier)
    if (!plan) {
      return c.json({ error: 'Invalid plan. Must be: pro, business, or enterprise', errorCode: 'INVALID_PLAN' }, 400)
    }

    const authError = requireAgentApiKey(c, body.beamId)
    if (authError) {
      return authError
    }

    const stripe = getStripe()
    const appUrl = process.env.APP_URL || 'https://beam.directory'

    // Check for existing customer
    const existing = db.prepare('SELECT stripe_customer_id FROM billing WHERE beam_id = ? ORDER BY created_at DESC LIMIT 1').get(body.beamId) as { stripe_customer_id: string } | undefined

    const sessionParams: any = {
      mode: 'subscription' as const,
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: PLAN_AMOUNTS[plan],
          recurring: { interval: 'year' as const },
          product_data: {
            name: PLAN_NAMES[plan],
            description: `Beam Protocol ${plan} plan for ${body.beamId}`,
          },
        },
        quantity: 1,
      }],
      metadata: {
        beam_id: body.beamId,
        plan,
      },
      success_url: safeReturnUrl(
        body.successUrl,
        `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        appUrl,
      ),
      cancel_url: safeReturnUrl(body.cancelUrl, `${appUrl}/#pricing`, appUrl),
    }

    if (existing?.stripe_customer_id) {
      sessionParams.customer = existing.stripe_customer_id
    }

    // Use env-configured price IDs if available
    const priceEnvKey = `STRIPE_PRICE_${plan.toUpperCase()}`
    const priceId = process.env[priceEnvKey]
    if (priceId) {
      sessionParams.line_items = [{ price: priceId, quantity: 1 }]
    }

    const session = await stripe.checkout.sessions.create(sessionParams)

    return c.json({ url: session.url, sessionId: session.id })
  })

  /**
   * POST /billing/webhook
   * Stripe webhook handler — verifies signature and processes events
   */
  app.post('/webhook', async (c) => {
    const stripe = getStripe()
    const sig = c.req.header('stripe-signature')
    const secret = process.env.STRIPE_WEBHOOK_SECRET

    if (!sig || !secret) {
      return c.json({ error: 'Webhook not configured' }, 400)
    }

    const rawBody = await c.req.text()

    let event: any
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret)
    } catch (err: any) {
      console.error('Webhook signature verification failed:', err.message)
      return c.json({ error: 'Invalid signature' }, 400)
    }

    const now = new Date().toISOString()

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const beamId = session.metadata?.beam_id
        const plan = normalizePlan(session.metadata?.plan ?? session.metadata?.tier)

        if (!beamId || !BEAM_ID_RE.test(beamId) || !plan || !getAgent(db, beamId)) break

        // Upsert billing record
        db.prepare(`
          INSERT INTO billing (beam_id, stripe_customer_id, stripe_subscription_id, tier, status, created_at)
          VALUES (?, ?, ?, ?, 'active', ?)
          ON CONFLICT(beam_id) DO UPDATE SET
            stripe_customer_id = excluded.stripe_customer_id,
            stripe_subscription_id = excluded.stripe_subscription_id,
            tier = excluded.tier,
            status = 'active',
            created_at = excluded.created_at
        `).run(beamId, session.customer, session.subscription, plan, now)

        // A commercial plan grants capacity/features, never identity assurance.
        db.prepare('UPDATE agents SET plan = ?, last_seen = ? WHERE beam_id = ?').run(plan, now, beamId)

        console.log(`Agent ${beamId} subscribed to the ${plan} plan via Stripe`)
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object
        // Find agent by subscription
        const billing = db.prepare('SELECT beam_id FROM billing WHERE stripe_subscription_id = ?').get(sub.id) as { beam_id: string } | undefined
        if (billing) {
          db.prepare("UPDATE billing SET status = 'canceled' WHERE stripe_subscription_id = ?").run(sub.id)
          db.prepare("UPDATE agents SET plan = 'free' WHERE beam_id = ?").run(billing.beam_id)
          console.log(`Agent ${billing.beam_id} returned to the free plan — subscription canceled`)
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        const billing = db.prepare('SELECT beam_id FROM billing WHERE stripe_customer_id = ?').get(invoice.customer) as { beam_id: string } | undefined
        if (billing) {
          db.prepare("UPDATE billing SET status = 'past_due' WHERE beam_id = ?").run(billing.beam_id)
          console.log(`⚠️ Payment failed for ${billing.beam_id}`)
        }
        break
      }
    }

    return c.json({ received: true })
  })

  /**
   * GET /billing/status/:beamId
   * Check billing/subscription status
   */
  app.get('/status/:beamId', (c) => {
    const beamId = c.req.param('beamId')
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId' }, 400)
    }

    const authError = requireAgentApiKey(c, beamId)
    if (authError) return authError

    const row = db.prepare(`
      SELECT * FROM billing WHERE beam_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(beamId) as BillingRow | undefined

    if (!row) {
      return c.json({ plan: 'free', active: true, paid: false })
    }

    return c.json({
      plan: row.tier,
      active: row.status === 'active',
      paid: true,
      status: row.status,
      currentPeriodEnd: row.current_period_end,
    })
  })

  /**
   * GET /billing/success
   * Success page after checkout
   */
  app.get('/success', (c) => {
    const sessionId = c.req.query('session_id')
    return c.html(`<!DOCTYPE html>
<html><head><title>Payment Successful — Beam Protocol</title>
<style>body{background:#0a0a0f;color:#e4e4ef;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:48px;max-width:480px}h1{color:#10b981;margin-bottom:12px}a{color:#00d4ff}</style></head>
<body><div class="box">
<h1>✅ Payment Successful</h1>
<p>Your Beam plan is active. Identity verification remains an independent evidence-based process.</p>
<p style="margin-top:24px"><a href="/">← Back to Directory</a></p>
</div></body></html>`)
  })

  // S3: Usage metering endpoint
  app.get('/usage/:beamId', async (c) => {
    const beamId = c.req.param('beamId')
    if (!BEAM_ID_RE.test(beamId)) return c.json({ error: 'Invalid beam_id' }, 400)

    const agent = getAgent(db, beamId)
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    const authError = requireAgentApiKey(c, beamId)
    if (authError) return authError

    const period = c.req.query('period') || new Date().toISOString().slice(0, 7) // YYYY-MM
    const usage = db.prepare(
      'SELECT intent_count, encrypted_count, direct_count, relayed_count FROM usage_metering WHERE beam_id = ? AND period = ?'
    ).get(beamId, period) as { intent_count: number; encrypted_count: number; direct_count: number; relayed_count: number } | undefined

    // Plan limits
    const planLimits: Record<string, { daily: number; overage: number }> = {
      free: { daily: 100, overage: 0 },
      pro: { daily: 10_000, overage: 0.001 },
      business: { daily: 100_000, overage: 0.0005 },
      enterprise: { daily: Infinity, overage: 0 },
    }
    const plan = agent.plan || 'free'
    const limits = planLimits[plan] ?? planLimits.free

    return c.json({
      beamId,
      period,
      plan,
      usage: usage ?? { intent_count: 0, encrypted_count: 0, direct_count: 0, relayed_count: 0 },
      limits: {
        dailyIntents: limits.daily,
        overagePricePerIntent: limits.overage,
      },
    })
  })

  return app
}
