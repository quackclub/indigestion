import type { WebClient } from "@slack/web-api";

interface SchemaField {
  action_id: string;
  label: string;
  type: string; // "plain_text_input" | "file_input" | "multi_static_select" | "static_select" | "datepicker" | "url_text_input" | "email_text_input" | "number_input"
  placeholder?: string;
  initial_value?: string;
  multiline?: boolean;
  min_length?: number;
  max_length?: number;
  options?: { label: string; value: string }[];
}

export interface MetadataSchema {
  title: string;
  submit_label?: string;
  fields: SchemaField[];
}

function buildBlocks(schema: MetadataSchema): any[] {
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: schema.title, emoji: true } },
    { type: "divider" },
  ];

  for (const field of schema.fields) {
    const element: any = { type: field.type, action_id: field.action_id };

    switch (field.type) {
      case "plain_text_input":
      case "url_text_input":
      case "email_text_input":
        element.placeholder = field.placeholder ? { type: "plain_text", text: field.placeholder } : undefined;
        element.initial_value = field.initial_value;
        element.multiline = field.multiline;
        element.min_length = field.min_length;
        element.max_length = field.max_length;
        break;

      case "number_input":
        element.placeholder = field.placeholder ? { type: "plain_text", text: field.placeholder } : undefined;
        element.initial_value = field.initial_value;
        element.min_length = field.min_length;
        element.max_length = field.max_length;
        element.is_decimal_allowed = false;
        break;

      case "static_select":
      case "multi_static_select":
        element.placeholder = field.placeholder ? { type: "plain_text", text: field.placeholder } : undefined;
        element.options = (field.options || []).map((o) => ({ text: { type: "plain_text", text: o.label }, value: o.value }));
        break;

      case "datepicker":
        element.placeholder = field.placeholder ? { type: "plain_text", text: field.placeholder } : undefined;
        element.initial_date = field.initial_value;
        break;

      case "file_input":
        // file_input requires specific setup in Slack — use as-is
        break;
    }

    blocks.push({
      type: "input",
      block_id: `field_${field.action_id}`,
      label: { type: "plain_text", text: field.label, emoji: true },
      element,
    });
  }

  return blocks;
}

function extractMetadata(schema: MetadataSchema, state: Record<string, Record<string, { value?: string; selected_options?: { value: string }[]; selected_date?: string; files?: any[] }>>): Record<string, any> {
  const metadata: Record<string, any> = {};
  for (const field of schema.fields) {
    const values = state?.[`field_${field.action_id}`]?.[field.action_id];
    if (!values) continue;

    switch (field.type) {
      case "multi_static_select":
        metadata[field.action_id] = values.selected_options?.map((o) => o.value) || [];
        break;
      case "datepicker":
        metadata[field.action_id] = values.selected_date || "";
        break;
      case "file_input":
        metadata[field.action_id] = values.files || [];
        break;
      default:
        metadata[field.action_id] = values.value || "";
    }
  }
  return metadata;
}

export async function openMetadataModal(
  client: WebClient,
  triggerId: string,
  channelId: string,
  messageTs: string,
  schema: MetadataSchema,
) {
  const blocks = buildBlocks(schema);

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "metadata_modal",
      title: { type: "plain_text", text: schema.title, emoji: true },
      submit: { type: "plain_text", text: schema.submit_label || "Save to Feed", emoji: true },
      close: { type: "plain_text", text: "Cancel", emoji: true },
      private_metadata: JSON.stringify({ channelId, messageTs }),
      notify_on_close: true,
      blocks,
    } as any,
  });
}

export function extractMetadataFromView(
  schema: MetadataSchema,
  state: Record<string, Record<string, { value?: string; selected_options?: { value: string }[]; selected_date?: string; files?: any[] }>>,
): string {
  const metadata = extractMetadata(schema, state);
  return JSON.stringify(metadata);
}
