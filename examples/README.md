# Examples

Two `.warp` workflows, both verified to compile against the live runtime at
`https://warp.aimer.ma`.

| File | What it shows |
|------|---------------|
| [`cart_recovery.warp`](cart_recovery.warp) | A cart abandoned for 30 minutes triggers a customer-profile lookup and a WhatsApp reminder. The compiler checks that `profile.phone` is a `PhoneNumber` before it reaches `WhatsAppSend.to`. |
| [`post_purchase.warp`](post_purchase.warp) | A post-purchase thank-you. Demonstrates two commerce-model invariants: capacity verification before a commitment is Accepted (I-3), and Commitments forming before Fulfillments execute (I-4). |

## Compile one

Replace `your-tenant-id` with your tenant id, then:

```bash
jq -Rs --arg t "YOUR_TENANT_ID" '{tenant_id:$t, warp_source:.}' cart_recovery.warp \
  | curl -s -X POST https://warp.aimer.ma/api/v1/workflows/compile \
      -H "content-type: application/json" \
      -H "X-Warp-API-Key: YOUR_API_KEY" \
      --data @-
```

See the [Getting Started guide](../docs/GETTING_STARTED.md) for how to get a
tenant id and API key.
