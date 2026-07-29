import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { AppAccessDriftNotice } from "./AppAccessDriftNotice";

afterEach(() => cleanup());

const deployment = {
  apiBaseUrl: "https://new.execute-api.eu-west-1.amazonaws.com",
  userPoolId: "eu-west-1_NEWPOOL",
  clientId: "newclient",
  region: "eu-west-1",
};

describe("AppAccessDriftNotice", () => {
  it("warns about every domain that drifted (stale/unregistered) after a rebuild", async () => {
    const listDomains = vi.fn(async () => ["ok.com", "stale.com", "gone.com"]);
    const check = vi.fn(async (domain: string) =>
      domain === "ok.com" ? ("current" as const) : domain === "stale.com" ? ("stale" as const) : ("unregistered" as const),
    );

    const open = vi.fn();
    render(
      <AppAccessDriftNotice
        deployment={deployment}
        stackName="MailpoppyMailStack"
        listDomains={listDomains}
        check={check}
        open={open}
      />,
    );

    expect(await screen.findByText(/Re-activate these domains/)).toBeInTheDocument();
    // Each drifted domain gets a one-click Re-activate; the healthy one is not listed.
    const buttons = await screen.findAllByRole("button", { name: /Re-activate/ });
    expect(buttons.length).toBe(2);
    expect(screen.getByText("stale.com")).toBeInTheDocument();
    expect(screen.getByText("gone.com")).toBeInTheDocument();
    expect(screen.queryByText("ok.com")).not.toBeInTheDocument();
    expect(check).toHaveBeenCalledWith("ok.com", expect.objectContaining({ userPoolId: "eu-west-1_NEWPOOL" }));

    // One click opens that domain's pre-filled Hub activation page.
    fireEvent.click(buttons[0]!);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\/activate\?domain=stale\.com/));
  });

  it("does not re-reconcile on every render when passed inline props (no infinite loop)", async () => {
    // Callers pass `deployment` as an inline object literal and fresh closures each
    // render (as the wizard does). The effect must key on the deployment VALUES, not the
    // object identity, or it loops forever (re-render → new object → effect → setState → …).
    const check = vi.fn(async () => "current" as const);
    function Wrapper() {
      const [, force] = useState(0);
      return (
        <>
          <button onClick={() => force((n) => n + 1)}>rerender</button>
          <AppAccessDriftNotice
            deployment={{ apiBaseUrl: "x", userPoolId: "y", clientId: "z", region: "eu-west-1" }}
            stackName="S"
            listDomains={async () => ["a.com"]}
            check={check}
          />
        </>
      );
    }
    render(<Wrapper />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("rerender"));
    fireEvent.click(screen.getByText("rerender"));
    await new Promise((r) => setTimeout(r, 10));
    expect(check).toHaveBeenCalledTimes(1); // unchanged values → no re-reconcile
  });

  it("renders nothing when every domain is current", async () => {
    const { container } = render(
      <AppAccessDriftNotice
        deployment={deployment}
        stackName="MailpoppyMailStack"
        listDomains={async () => ["a.com", "b.com"]}
        check={async () => "current" as const}
      />,
    );
    // Give the effect a tick; it must resolve to empty and render null.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
