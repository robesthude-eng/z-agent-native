import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderChannel } from "@/api/providerChannels";
import { ComposerSuggestions } from "./composer/ComposerSuggestions";
import { ProviderChannelList } from "./settings/provider-channels/ProviderChannelList";
import { WorkspaceCreateForm } from "./workspace/WorkspaceMetaSections";

describe("refactored UI sections", () => {
  it("keeps composer command selection interactive", () => {
    const onCommand = vi.fn();
    const command = { cmd: "/test", hint: "Run tests", insert: "run" };
    render(
      <ComposerSuggestions
        commands={[command]}
        files={[]}
        commandIndex={0}
        fileIndex={0}
        onCommand={onCommand}
        onFile={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /\/test/i }));
    expect(onCommand).toHaveBeenCalledWith(command);
  });

  it("submits and cancels workspace creation from the keyboard", () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <WorkspaceCreateForm
        kind="file"
        value="src/app.ts"
        onChange={onChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    const input = screen.getByDisplayValue("src/app.ts");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps provider selection outside the controller", () => {
    const onSelect = vi.fn();
    const channels: ProviderChannel[] = [
      {
        id: "demo",
        name: "Demo Provider",
        protocol: "openai",
        baseURL: "https://api.example.com/v1",
        enabled: true,
        custom: true,
        connected: true,
      },
    ];
    render(
      <ProviderChannelList
        channels={channels}
        selectedId={null}
        loading={false}
        onAdd={vi.fn()}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Demo Provider/i }));
    expect(onSelect).toHaveBeenCalledWith("demo");
  });
});
