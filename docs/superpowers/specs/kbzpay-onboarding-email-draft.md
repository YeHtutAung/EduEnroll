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

- Please register this URL for our merchant account.
- **Do you require our outbound server IP addresses to be allowlisted** in
  order to call your APIs? If so, please tell us the process, and note that our
  application runs on a cloud platform with a range of egress addresses rather
  than a single static IP.
- Please also confirm the source IP ranges your callbacks originate from, if
  you publish them.

We will provide a separate UAT callback URL once credentials are issued.

## 4. Amount format for MMK

The specification states that `total_amount` may contain up to two decimal
places. MMK is normally transacted in whole kyat, and we store amounts as
integers.

**Could you confirm the expected convention for MMK?** Specifically:

- Should we send `"40000"` or `"40000.00"`?
- In the `queryorder` response and the callback, will `total_amount` ever be
  returned with decimal places for an MMK transaction?

We compare the notified amount against our own recorded order amount before
confirming a payment, so we need to match your formatting exactly.

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

Section 4 is the one most likely to cause a silent production failure. If they
send `"40000.00"` where we expect `"40000"`, every settlement fails the amount
guard and payments stall as `awaiting_payment` — money taken, enrolment not
confirmed. Worth pressing for a clear answer rather than an assumption.

Section 2 is the one to escalate if the answer is unsatisfactory. Plaintext
HTTP for a signed merchant API is a real finding, not a formality.
