import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/auth/forgot-password", { email });
      // Same response whether or not the account exists — see auth/routes.ts's comment on
      // /auth/forgot-password — so this message stays generic no matter what.
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-ink">Reset your password</h1>
        {submitted ? (
          <p className="text-sm text-muted">
            If an account with that email exists, a password reset link has been sent.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-muted">Enter your account email and we'll send a reset link.</p>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-md border border-line px-3 py-2 text-sm"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-accent py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              Send reset link
            </button>
          </form>
        )}
        <Link to="/login" className="block text-center text-sm text-muted hover:underline">
          Back to login
        </Link>
      </div>
    </div>
  );
}
