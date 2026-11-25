const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

/** Subset of the Mailpit API address object used by the tests. */
export interface MailpitAddress {
  Name: string;
  Address: string;
}

/** Subset of a message summary returned by `GET /api/v1/messages`. */
export interface MailpitMessageSummary {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
}

/** Subset of a message returned by `GET /api/v1/message/{id}`. */
export interface MailpitMessageDetail extends MailpitMessageSummary {
  HTML: string;
  Text: string;
}

interface MailpitMessagesResponse {
  messages: MailpitMessageSummary[] | null;
}

export async function getMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as MailpitMessagesResponse;
  return data.messages ?? [];
}

export async function getMailpitMessage(
  id: string,
): Promise<MailpitMessageDetail> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessageDetail;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
