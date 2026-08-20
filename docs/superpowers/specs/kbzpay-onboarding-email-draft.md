# KBZPay onboarding — email draft

Draft only. Review before sending; fill the bracketed placeholders.

**To:** KBZPay PGW integration / IT team
**Cc:** [your ops contact]
**Subject:** MMQR (PAY_BY_QRCODE) integration — UAT credentials and four technical questions

---

Dear KBZPay team,

We are integrating KBZPay MMQR into our enrolment and ticketing platform,
Kuu Nyi (kuunyi.com), operated by [Nihon Moment / legal entity name].

Our server-side integration against the published PGW specification is complete
and covered by automated tests. We are using the MMQR product with
`trade_type: PAY_BY_QRCODE`, and the following interfaces:

- `kbz.payment.precreate` (version 1.0)
- `kbz.payment.queryorder` (version 3.0)
- `kbz.payment.closeorder` (version 3.0)
- the asynchronous payment callback to our `notify_url`

We are not using the refund interface at this stage.

Before we can begin UAT testing we need credentials, and we would be grateful
for clarification on four technical points.

## 1. UAT credentials

Please issue UAT credentials for our merchant account:

- `appid`
- `merch_code`
- app key (for SHA256 signing)

**Please send the app key through a secure channel** rather than in plain email
— for example a password-protected file with the passphrase sent separately, a
secrets link, or your standard secure-delivery process. We are happy to work
with whatever mechanism you normally use; please let us know which you prefer.

If you require any registration details from our side to proceed, please let us
know what is outstanding.

## 2. HTTPS on the UAT host

Your documentation lists the UAT endpoints for `precreate` and `queryorder`
with an `http://` scheme, while `closeorder` is listed as `https://`:

```
http://api-uat.kbzpay.com/payment/gateway/uat/precreate
http://api-uat.kbzpay.com/payment/gateway/uat/queryorder
https://api-uat.kbzpay.com/payment/gateway/uat/closeorder
```

Our client always uses HTTPS, as we are not willing to transmit merchant
credentials or request signatures over an unencrypted connection, even in a
test environment.

**Could you confirm that `https://api-uat.kbzpay.com` is supported for all
three endpoints?** If the UAT environment is genuinely HTTP-only, please let us
know, as we would need to discuss that before using a live app key there.

## 3. Callback URL registration and IP allowlisting

Our production callback URL will be:

```
https://www.kuunyi.com/api/webhooks/kbzpay
```

Please note the `www` prefix is required — our apex domain issues a 307
redirect, and redirects are not followed for POST callbacks.

Please register this URL for our merchant account. We will provide a separate
UAT callback URL once credentials are issued.

We have two separate questions about IP addresses.

**a. Outbound — our calls to you.** Do you require our server egress IP
addresses to be allowlisted before we can call `precreate`, `queryorder` and
`closeorder`? If so, please tell us the process. Note that our application runs
on a cloud platform that uses a range of egress addresses rather than a single
static IP, so if a fixed IP is mandatory we will need to discuss how to
accommodate that.

**b. Inbound — your callbacks to us.** Do you publish the source IP ranges your
callbacks originate from, and do you support or recommend restricting our
`notify_url` to those ranges? We verify every callback signature and confirm
each payment with a server-to-server `queryorder` before acting on it, so this
is defence in depth rather than something we depend on — but we would apply it
if the ranges are stable and published.

## 4. Amount format for MMK

The specification states that `total_amount` may contain up to two decimal
places. MMK is normally transacted in whole kyat, and we store order amounts as
whole-kyat integers.

We parse `total_amount` numerically, so `"40000"` and `"40000.00"` are
equivalent to us and either format is fine. What we need to know is whether a
**fractional** MMK value can ever occur:

- Can `total_amount` ever be **accepted** with a non-zero fractional part for an
  MMK transaction — for example `"40000.50"`?
- Can `total_amount` ever be **returned** with a non-zero fractional part in the
  `queryorder` response or the callback, for an order we submitted as a whole
  number?

If fractional MMK amounts are possible we will need to adjust how we store order
amounts. If MMK is always whole kyat in practice, no change is needed and we
would simply like that confirmed.

## 5. Two smaller confirmations

- **`trade_status` whitespace.** The success example in your `queryorder`
  documentation shows `"trade_status": " PAY_SUCCESS"` with a leading space. We
  trim the value defensively, but could you confirm whether that space is
  present in real responses or is a typographical error in the documentation?
- **Order expiry.** We set `timeout_express` to `120m`. Does the `queryorder`
  response expose the order's expiry time in any field? It is not listed in the
  specification, and having it would let us align our own expiry handling with
  yours precisely.

## Timeline

We are ready to begin UAT as soon as credentials are available. Please let us
know the expected turnaround, and whether you need anything further from us.

Kind regards,

[Your name]
[Role]
[Nihon Moment / entity]
[Phone] · [Email]

---

## Notes for you, not for the email

Each section maps to a gate in the design spec:

| Section | Gate | Blocks |
|---|---|---|
| 1 — credentials | G1 | Live UAT verification |
| 2 — HTTPS | G2 | Using a real app key anywhere |
| 3 — callback URL / IP | G3, G4 | Production go-live |
| 4 — MMK decimals | G5 | The settlement amount comparison |
| 5 — whitespace, expiry | — | Not blocking; both already handled defensively |

**Correction to an earlier version of this note.** It claimed that a
`"40000.00"` response would fail the amount guard and stall every settlement.
That was wrong. `settleMmqrPayment` compares `Number(observedAmount) !==
Number(payment.amount)`, and all three call sites — webhook, status poller and
resolve procedure — pass `total_amount` through `Number()`. `"40000.00"`
normalises to `40000` and settles cleanly. Formatting is not the risk.

The real exposure in section 4 is narrower: `payments.amount` is an `integer`
column, so a genuinely **fractional** MMK amount could not be represented in the
snapshot we validate against. If that ever occurred the comparison would refuse
to settle — which is the correct behaviour, but it would mean money taken
against an order we cannot confirm. That is why the question asks about
fractional *values*, not about string formatting.

Section 2 is the one to escalate if the answer is unsatisfactory. Plaintext
HTTP for a signed merchant API is a real finding, not a formality.

Section 3b is deliberately framed as defence in depth. Callback signatures are
verified and every payment is confirmed by a server-to-server `queryorder`
before it settles, so IP restriction is a bonus rather than a control we rely
on — worth saying plainly so nobody later assumes it is load-bearing.
