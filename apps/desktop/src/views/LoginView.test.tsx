import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LoginView } from "./LoginView";
import type { Authenticator, SignInResult } from "../lib/auth";

afterEach(() => cleanup());

function mockAuth(over: Partial<Authenticator> = {}): Authenticator & Record<string, ReturnType<typeof vi.fn>> {
  return {
    signIn: vi.fn(async (): Promise<SignInResult> => ({ status: "signed-in", email: "you@x.com" })),
    completeNewPassword: vi.fn(async (): Promise<SignInResult> => ({ status: "signed-in", email: "you@x.com" })),
    getToken: vi.fn(async () => "jwt"),
    signOut: vi.fn(),
    hasSession: vi.fn(() => false),
    ...over,
  } as Authenticator & Record<string, ReturnType<typeof vi.fn>>;
}

describe("LoginView", () => {
  it("signs in with the entered credentials", async () => {
    const auth = mockAuth();
    const onSignedIn = vi.fn();
    render(<LoginView auth={auth} onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "you@x.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(auth.signIn).toHaveBeenCalledWith("you@x.com", "hunter2");
  });

  it("prompts for a new password when the account requires it", async () => {
    const auth = mockAuth({
      signIn: vi.fn(async () => ({ status: "new-password-required", email: "you@x.com" })),
    });
    const onSignedIn = vi.fn();
    render(<LoginView auth={auth} onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "you@x.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Temp123!" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // Now a new-password field appears; first sign-in did not complete.
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Permanent123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Set password/ }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(auth.completeNewPassword).toHaveBeenCalledWith("Permanent123!");
  });

  it("pre-fills the email when deep-linked from a specific mailbox", () => {
    const auth = mockAuth();
    render(<LoginView auth={auth} onSignedIn={vi.fn()} prefillEmail="info@boxord.com" />);
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("info@boxord.com");
  });

  it("shows the recovery key once when a keypair is created, and continues only after acknowledgement", async () => {
    const auth = mockAuth();
    const onSignedIn = vi.fn();
    const onEstablishKeys = vi.fn(async () => ({ created: true, rekeyed: false, recoveryKey: "RECOVER-ME-1234" }));
    render(<LoginView auth={auth} onSignedIn={onSignedIn} onEstablishKeys={onEstablishKeys} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "you@x.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // The recovery key is shown and the inbox is NOT entered yet.
    expect(await screen.findByText("Save your recovery key")).toBeInTheDocument();
    expect(screen.getByLabelText("Recovery key")).toHaveTextContent("RECOVER-ME-1234");
    expect(onEstablishKeys).toHaveBeenCalledWith("hunter2", "you@x.com");
    expect(onSignedIn).not.toHaveBeenCalled();

    // Continue is gated on the acknowledgement checkbox.
    const cont = screen.getByRole("button", { name: /Continue to mailbox/ });
    expect(cont).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(cont);
    expect(onSignedIn).toHaveBeenCalled();
  });

  it("skips the recovery panel when no keypair was created", async () => {
    const auth = mockAuth();
    const onSignedIn = vi.fn();
    const onEstablishKeys = vi.fn(async () => ({ created: false, rekeyed: false }));
    render(<LoginView auth={auth} onSignedIn={onSignedIn} onEstablishKeys={onEstablishKeys} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "you@x.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(screen.queryByText("Save your recovery key")).not.toBeInTheDocument();
  });

  it("still signs in if key establishment fails (encryption is non-blocking during rollout)", async () => {
    const auth = mockAuth();
    const onSignedIn = vi.fn();
    const onEstablishKeys = vi.fn(async () => {
      throw new Error("keys endpoint unavailable");
    });
    render(<LoginView auth={auth} onSignedIn={onSignedIn} onEstablishKeys={onEstablishKeys} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "you@x.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });

  it("shows an error when authentication fails", async () => {
    const auth = mockAuth({
      signIn: vi.fn(async () => {
        throw new Error("Incorrect username or password.");
      }),
    });
    render(<LoginView auth={auth} onSignedIn={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "you@x.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/Incorrect username or password/)).toBeInTheDocument();
  });
});
