import { MyModelsSection } from "./MyModelsSection";
import { ProvidersTabContent } from "./ProvidersTabContent";

/** Native model management: personal models and provider credentials. */
export function ModelsTabContent() {
  return (
    <div className="space-y-8">
      <MyModelsSection />
      <div className="border-t border-border" />
      <ProvidersTabContent />
    </div>
  );
}
