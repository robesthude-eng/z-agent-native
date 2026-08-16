import { ProviderChannelManager } from "./ProviderChannelManager";

/** Provider-first model management inspired by ZCode: connect a channel, then sync its models. */
export function ModelsTabContent() {
  return <ProviderChannelManager />;
}
