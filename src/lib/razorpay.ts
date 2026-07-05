import crypto from "crypto";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

function razorpayConfigured(): boolean {
  return !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && !RAZORPAY_KEY_ID.includes("test_xx"));
}

function auth(): string {
  return Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
}

export interface PayoutResult {
  success: boolean;
  gatewayTxnId?: string;
  status?: string;
  error?: string;
}

/**
 * Automated payout via Razorpay Payouts API (UPI).
 * Transfers funds from your Razorpay account to a user's UPI ID.
 */
export async function createUpiPayout(
  amountInr: number,
  upiId: string,
  referenceId: string,
  notes?: Record<string, string>,
): Promise<PayoutResult> {
  if (!razorpayConfigured()) {
    return { success: false, error: "Razorpay not configured" };
  }
  if (amountInr < 1) {
    return { success: false, error: "Amount must be at least ₹1" };
  }
  const amountInPaise = Math.round(amountInr * 100);
  try {
    const resp = await fetch("https://api.razorpay.com/v1/payouts", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_number: process.env.RAZORPAY_ACCOUNT_NUMBER || "",
        fund_account: {
          account_type: "vpa",
          vpa: { address: upiId },
          contact: {
            name: notes?.name || "User",
            type: "customer",
          },
        },
        amount: amountInPaise,
        currency: "INR",
        mode: "UPI",
        purpose: "payout",
        reference_id: referenceId,
        notes: notes || {},
      }),
    });
    const data: any = await resp.json();
    if (!resp.ok) {
      return { success: false, error: data.error?.description || data.message || "Razorpay payout failed" };
    }
    return {
      success: true,
      gatewayTxnId: data.id,
      status: data.status,
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Payout request failed" };
  }
}

/**
 * Automated payout via Razorpay Payouts API (Bank transfer / NEFT / IMPS).
 */
export async function createBankPayout(
  amountInr: number,
  bankDetails: { name: string; accountNumber: string; ifsc: string; accountName: string },
  referenceId: string,
  notes?: Record<string, string>,
): Promise<PayoutResult> {
  if (!razorpayConfigured()) {
    return { success: false, error: "Razorpay not configured" };
  }
  if (amountInr < 1) {
    return { success: false, error: "Amount must be at least ₹1" };
  }
  const amountInPaise = Math.round(amountInr * 100);
  try {
    const resp = await fetch("https://api.razorpay.com/v1/payouts", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_number: process.env.RAZORPAY_ACCOUNT_NUMBER || "",
        fund_account: {
          account_type: "bank_account",
          bank_account: {
            name: bankDetails.accountName,
            ifsc: bankDetails.ifsc,
            account_number: bankDetails.accountNumber,
          },
          contact: {
            name: bankDetails.name,
            type: "customer",
          },
        },
        amount: amountInPaise,
        currency: "INR",
        mode: "NEFT",
        purpose: "payout",
        reference_id: referenceId,
        notes: notes || {},
      }),
    });
    const data: any = await resp.json();
    if (!resp.ok) {
      return { success: false, error: data.error?.description || data.message || "Razorpay payout failed" };
    }
    return {
      success: true,
      gatewayTxnId: data.id,
      status: data.status,
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Payout request failed" };
  }
}

/**
 * Verify Razorpay webhook signature.
 */
export function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return expected === signature;
}

export { razorpayConfigured, RAZORPAY_KEY_ID };
