import type {EncryptedMailAddress, Mail} from "../../api/entities/tutanota/TypeRefs.js"
import {FileTypeRef, MailAddress, MailBodyTypeRef, MailHeadersTypeRef} from "../../api/entities/tutanota/TypeRefs.js"
import type {EntityClient} from "../../api/common/EntityClient"
import {getMailBodyText, getMailHeaders} from "../../api/common/utils/Utils"
import {MailState} from "../../api/common/TutanotaConstants"
import {getLetId} from "../../api/common/utils/EntityUtils"
import type {HtmlSanitizer} from "../../misc/HtmlSanitizer"
import {promiseMap} from "@tutao/tutanota-utils"
import {DataFile} from "../../api/common/DataFile";
import {FileController} from "../../file/FileController"

/**
 * Used to pass all downloaded mail stuff to the desktop side to be exported as a file
 * Ideally this would just be {Mail, MailHeaders, MailBody, FileReference[]}
 * but we can't send Dates over to the native side so we may as well just extract everything here
 */
export type MailBundleRecipient = {
	address: string
	name?: string
}
export type MailBundle = {
	mailId: IdTuple
	subject: string
	body: string
	sender: MailBundleRecipient
	to: MailBundleRecipient[]
	cc: MailBundleRecipient[]
	bcc: MailBundleRecipient[]
	replyTo: MailBundleRecipient[]
	isDraft: boolean
	isRead: boolean
	sentOn: number
	// UNIX timestamp
	receivedOn: number
	// UNIX timestamp,
	headers: string | null
	attachments: DataFile[]
}

/**
 * Downloads the mail body and the attachments for an email, to prepare for exporting
 */
export async function makeMailBundle(mail: Mail, entityClient: EntityClient, fileController: FileController, sanitizer: HtmlSanitizer): Promise<MailBundle> {
	const body = sanitizer.sanitizeHTML(
		getMailBodyText(await entityClient.load(MailBodyTypeRef, mail.body)),
		{
			blockExternalContent: false,
			allowRelativeLinks: false,
			usePlaceholderForInlineImages: false,
		},
	).html

	const attachments = await promiseMap(
		mail.attachments,
		async fileId => {
			const file = await entityClient.load(FileTypeRef, fileId)
			return await fileController.downloadAndDecrypt(file)
		},
	)

	const headers = mail.headers != null
		? getMailHeaders(await entityClient.load(MailHeadersTypeRef, mail.headers))
		: null

	const recipientMapper = ({address, name}: MailAddress | EncryptedMailAddress) => ({address, name})

	return {
		mailId: getLetId(mail),
		subject: mail.subject,
		body,
		sender: recipientMapper(mail.sender),
		to: mail.toRecipients.map(recipientMapper),
		cc: mail.ccRecipients.map(recipientMapper),
		bcc: mail.bccRecipients.map(recipientMapper),
		replyTo: mail.replyTos.map(recipientMapper),
		isDraft: mail.state === MailState.DRAFT,
		isRead: !mail.unread,
		sentOn: mail.sentDate.getTime(),
		receivedOn: mail.receivedDate.getTime(),
		headers,
		attachments,
	}
}