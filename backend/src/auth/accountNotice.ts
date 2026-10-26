import type { Context } from "hono";
import {
    accountChangedTemplate,
    type AccountChange,
} from "../mail/accountChangedTemplate.js";
import { sendMail } from "../mail/mailer.js";
import { publicUrl } from "./publicUrl.js";

// Tells the owner about a change to how their account can be signed in to.
// The change already stands, so a failed send is only logged, and the mail
// goes out in the background so a slow SMTP server doesn't hold up the response.
export function notifyAccountChange(
    c: Context,
    user: { id: number; email: string },
    change: AccountChange,
) {
    sendMail({
        to: user.email,
        ...accountChangedTemplate(
            change,
            user.email,
            publicUrl(c, "/settings"),
        ),
    }).catch((err) => {
        console.error(
            `Couldn't send ${change.kind} notice to user ${user.id}`,
            err,
        );
    });
}
