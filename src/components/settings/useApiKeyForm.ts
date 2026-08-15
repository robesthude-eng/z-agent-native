import { useState } from "react";
import { useStore } from "../../store/useStore";

/**
 * Shared logic for "paste an API key, save it" forms (provider forms and
 * BYOK Providers tab both need this independently — each gets its own
 * isolated instance so typing in one tab never leaks into the other).
 */
export function useApiKeyForm() {
  const saveKey = useStore((s) => s.saveKey);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const setValue = (id: string, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
  };

  const handleSave = async (id: string) => {
    const key = (values[id] ?? "").trim();
    if (!key) return false;
    setSaving(id);
    const ok = await saveKey(id, key);
    setSaving(null);
    if (ok) {
      setValue(id, "");
    }
    return ok;
  };

  return { values, saving, setValue, handleSave };
}
