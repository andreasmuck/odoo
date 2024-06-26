import { Component, useState } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";
import { FollowerSubtypeDialog } from "./follower_subtype_dialog";
import { useVisible } from "@mail/utils/common/hooks";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";

/**
 * @typedef {Object} Props
 * @property {function} [onAddFollowers]
 * @property {function} [onFollowerChanged]
 * @property {import('@mail/core/common/thread_model').Thread} thread
 * @extends {Component<Props, Env>}
 */

export class FollowerList extends Component {
    static template = "mail.FollowerList";
    static components = { DropdownItem };
    static props = ["onAddFollowers?", "onFollowerChanged?", "thread", "dropdown"];

    setup() {
        this.action = useService("action");
        this.messaging = useState(useService("mail.messaging"));
        this.threadService = useState(useService("mail.thread"));
        useVisible("load-more", (isVisible) => {
            if (isVisible) {
                this.threadService.loadMoreFollowers(this.props.thread);
            }
        });
    }

    onClickAddFollowers() {
        const action = {
            type: "ir.actions.act_window",
            res_model: "mail.wizard.invite",
            view_mode: "form",
            views: [[false, "form"]],
            name: _t("Invite Follower"),
            target: "new",
            context: {
                default_res_model: this.props.thread.model,
                default_res_id: this.props.thread.id,
            },
        };
        this.action.doAction(action, {
            onClose: () => {
                this.props.onAddFollowers?.();
            },
        });
    }

    /**
     * @param {MouseEvent} ev
     * @param {import("models").Follower} follower
     */
    onClickDetails(ev, follower) {
        this.messaging.openDocument({ id: follower.partner.id, model: "res.partner" });
        this.props.dropdown.close();
    }

    /**
     * @param {MouseEvent} ev
     * @param {import("models").Follower} follower
     */
    async onClickEdit(ev, follower) {
        this.env.services.dialog.add(FollowerSubtypeDialog, {
            follower,
            onFollowerChanged: () => this.props.onFollowerChanged?.(this.props.thread),
        });
        this.props.dropdown.close();
    }

    /**
     * @param {MouseEvent} ev
     * @param {import("models").Follower} follower
     */
    async onClickRemove(ev, follower) {
        const thread = this.props.thread;
        await this.threadService.removeFollower(follower);
        this.props.onFollowerChanged?.(thread);
    }
}
