/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { _t } from "@web/core/l10n/translation";
import { SelectionPopup } from "@point_of_sale/app/utils/input_popups/selection_popup";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { TextInputPopup } from "@point_of_sale/app/utils/input_popups/text_input_popup";
import { Domain, InvalidDomainError } from "@web/core/domain";
import { ask, makeAwaitable } from "@point_of_sale/app/store/make_awaitable_dialog";
import { PartnerList } from "@point_of_sale/app/screens/partner_list/partner_list";

let nextId = -1;

export function loyaltyIdsGenerator() {
    return nextId--;
}

patch(PosStore.prototype, {
    async addLineToCurrentOrder(vals, opt = {}, configure = true) {
        const product = vals.product_id;
        const order = this.get_order();
        const linkedPrograms =
            this.models["loyalty.program"].getBy("trigger_product_ids", product.id) || [];
        let selectedProgram = null;
        if (linkedPrograms.length > 1) {
            selectedProgram = await makeAwaitable(this.dialog, SelectionPopup, {
                title: _t("Select program"),
                list: linkedPrograms.map((program) => ({
                    id: program.id,
                    item: program,
                    label: program.name,
                })),
            });
            if (!selectedProgram) {
                return;
            }
        } else if (linkedPrograms.length === 1) {
            selectedProgram = linkedPrograms[0];
        }

        const orderTotal = this.get_order().get_total_with_tax();
        if (
            selectedProgram &&
            ["gift_card", "ewallet"].includes(selectedProgram.program_type) &&
            orderTotal < 0
        ) {
            opt.price_unit = -orderTotal;
        }
        if (selectedProgram && selectedProgram.program_type == "gift_card") {
            const shouldProceed = await this._setupGiftCardOptions(selectedProgram, opt);
            if (!shouldProceed) {
                return;
            }
        } else if (selectedProgram && selectedProgram.program_type == "ewallet") {
            const shouldProceed = await this.setupEWalletOptions(selectedProgram, opt);
            if (!shouldProceed) {
                return;
            }
        }
        const potentialRewards = this.getPotentialFreeProductRewards();
        const rewardsToApply = [];
        for (const reward of potentialRewards) {
            for (const reward_product_id of reward.reward.reward_product_ids) {
                if (reward_product_id.id == product.id) {
                    rewardsToApply.push(reward);
                }
            }
        }

        // move price_unit from opt to vals
        if (opt.price_unit) {
            vals.price_unit = opt.price_unit;
            delete opt.price_unit;
        }

        const result = await super.addLineToCurrentOrder(vals, opt, configure);

        await order._updatePrograms();
        if (rewardsToApply.length == 1) {
            const reward = rewardsToApply[0];
            order._applyReward(reward.reward, reward.coupon_id, { product });
        }
        order._updateRewards();

        return result;
    },
    /**
     * Sets up the options for the gift card product.
     * @param {object} program
     * @param {object} options
     * @returns {Promise<boolean>} whether to proceed with adding the product or not
     */
    async _setupGiftCardOptions(program, options) {
        options.quantity = 1;
        options.merge = false;
        options.eWalletGiftCardProgram = program;

        // If gift card program setting is 'scan_use', ask for the code.
        if (this.config.gift_card_settings == "scan_use") {
            const code = await makeAwaitable(this.dialog, TextInputPopup, {
                title: _t("Generate a Gift Card"),
                placeholder: _t("Enter the gift card code"),
            });
            if (!code) {
                return false;
            }
            const trimmedCode = code.trim();
            if (trimmedCode && trimmedCode.startsWith("044")) {
                // check if the code exist in the database
                // if so, use its balance, otherwise, use the unit price of the gift card product
                const fetchedGiftCard = await this.data.searchRead(
                    "loyalty.card",
                    [
                        ["code", "=", trimmedCode],
                        ["program_id", "=", program.id],
                    ],
                    ["points", "source_pos_order_id", "code", "program_id"]
                );

                // There should be maximum one gift card for a given code.
                const giftCard = fetchedGiftCard[0];
                if (giftCard && giftCard.source_pos_order_id) {
                    this.dialog.add(AlertDialog, {
                        title: _t("This gift card has already been sold"),
                        body: _t("You cannot sell a gift card that has already been sold."),
                    });
                    return false;
                }
                options.giftBarcode = trimmedCode;
                if (giftCard) {
                    // Use the balance of the gift card as the price of the orderline.
                    // NOTE: No need to convert the points to price because when opening a session,
                    // the gift card programs are made sure to have 1 point = 1 currency unit.
                    options.price_unit = giftCard.points;
                    options.giftCardId = giftCard.id;
                }
            } else {
                this.env.services.notification.add("Please enter a valid gift card code.");
                return false;
            }
        }
        return true;
    },
    async setupEWalletOptions(program, options) {
        options.quantity = 1;
        options.merge = false;
        options.eWalletGiftCardProgram = program;
        return true;
    },
    /**
     * Returns the reward such that when its reward product is added
     * in the order, it will be added as free. That is, when added,
     * it comes with the corresponding reward product line.
     */
    async pay() {
        const currentOrder = this.get_order();
        const eWalletLine = currentOrder
            .get_orderlines()
            .find((line) => line.getEWalletGiftCardProgramType() === "ewallet");

        if (eWalletLine && !currentOrder.get_partner()) {
            const confirmed = await ask(this.env.services.dialog, {
                title: _t("Customer needed"),
                body: _t("eWallet requires a customer to be selected"),
            });
            if (confirmed) {
                this.dialog.add(PartnerList, {
                    getPayload: (newPartner) => currentOrder.set_partner(newPartner),
                });
            }
        } else {
            return super.pay(...arguments);
        }
    },
    getPotentialFreeProductRewards() {
        const order = this.get_order();
        const allCouponPrograms = Object.values(order.uiState.couponPointChanges)
            .map((pe) => {
                return {
                    program_id: pe.program_id,
                    coupon_id: pe.coupon_id,
                };
            })
            .concat(
                order.code_activated_coupon_ids.map((coupon) => {
                    return {
                        program_id: coupon.program_id.id,
                        coupon_id: coupon.id,
                    };
                })
            );
        const result = [];
        for (const couponProgram of allCouponPrograms) {
            const program = this.models["loyalty.program"].get(couponProgram.program_id);
            if (
                program.pricelist_ids.length > 0 &&
                (!order.pricelist_id || !program.pricelist_ids.includes(order.pricelist_id.id))
            ) {
                continue;
            }

            const points = order._getRealCouponPoints(couponProgram.coupon_id);
            const hasLine = order.lines.filter((line) => !line.is_reward_line).length > 0;
            for (const reward of program.reward_ids.filter(
                (reward) => reward.reward_type == "product"
            )) {
                if (points < reward.required_points) {
                    continue;
                }
                // Loyalty program (applies_on == 'both') should needs an orderline before it can apply a reward.
                const considerTheReward =
                    program.applies_on !== "both" || (program.applies_on == "both" && hasLine);
                if (reward.reward_type === "product" && considerTheReward) {
                    let hasPotentialQty = true;
                    let potentialQty;
                    for (const { id } of reward.reward_product_ids) {
                        const product = this.models["product.product"].get(id);
                        potentialQty = order._computePotentialFreeProductQty(
                            reward,
                            product,
                            points
                        );
                        if (potentialQty <= 0) {
                            hasPotentialQty = false;
                        }
                    }
                    if (hasPotentialQty) {
                        result.push({
                            coupon_id: couponProgram.coupon_id,
                            reward: reward,
                            potentialQty,
                        });
                    }
                }
            }
        }
        return result;
    },

    //@override
    async processServerData(loadedData) {
        await super.processServerData(loadedData);

        this.partnerId2CouponIds = {};

        for (const reward of this.models["loyalty.reward"].getAll()) {
            this.compute_discount_product_ids(reward, this.models["product.product"].getAll());
        }

        for (const program of this.models["loyalty.program"].getAll()) {
            if (program.date_to) {
                program.date_to = new Date(program.date_to);
            }
            if (program.date_from) {
                program.date_from = new Date(program.date_from);
            }
        }
    },

    compute_discount_product_ids(reward, products) {
        const reward_product_domain = JSON.parse(reward.reward_product_domain);
        if (!reward_product_domain) {
            return;
        }

        const domain = new Domain(reward_product_domain);

        try {
            reward.update({
                all_discount_product_ids: [
                    ["link", ...products.filter((p) => domain.contains(p.serialize()))],
                ],
            });
        } catch (error) {
            if (!(error instanceof InvalidDomainError)) {
                throw error;
            }
            const index = this.models["loyalty.reward"].indexOf(reward);
            if (index != -1) {
                this.env.services.dialog.add(AlertDialog, {
                    title: _t("A reward could not be loaded"),
                    body: _t(
                        'The reward "%s" contain an error in its domain, your domain must be compatible with the PoS client',
                        this.models["loyalty.reward"].getAll()[index].description
                    ),
                });

                this.models["loyalty.reward"].delete(reward.id);
            }
        }
    },
    async initServerData() {
        await super.initServerData(...arguments);
        if (this.selectedOrderUuid) {
            this.get_order()._updateRewards();
        }
    },
    set_order(order) {
        const result = super.set_order(...arguments);
        // FIXME - JCB: This is a temporary fix.
        // When an order is selected, it doesn't always contain the reward lines.
        // And the list of active programs are not always correct. This is because
        // of the use of DropPrevious in _updateRewards.
        if (order) {
            order._updateRewards();
        }
        return result;
    },
    /**
     * Fetches `loyalty.card` records from the server and adds/updates them in our cache.
     *
     * @param {domain} domain For the search
     * @param {int} limit Default to 1
     */
    async fetchCoupons(domain, limit = 1) {
        const result = await this.data.searchRead(
            "loyalty.card",
            domain,
            ["id", "points", "code", "partner_id", "program_id", "expiration_date"],
            { limit }
        );
        const couponList = [];
        for (const coupon of result) {
            this.partnerId2CouponIds[coupon.partner_id] =
                this.partnerId2CouponIds[coupon.partner_id] || new Set();
            this.partnerId2CouponIds[coupon.partner_id].add(coupon.id);
            couponList.push(coupon);
        }
        return couponList;
    },
    /**
     * Fetches a loyalty card for the given program and partner, put in cache afterwards
     *  if a matching card is found in the cache, that one is used instead.
     * If no card is found a local only card will be created until the order is validated.
     *
     * @param {int} programId
     * @param {int} partnerId
     */
    async fetchLoyaltyCard(programId, partnerId) {
        const coupon = this.models["loyalty.card"].find(
            (c) => c.partner_id?.id === partnerId && c.program_id?.id === programId
        );
        if (coupon) {
            return coupon;
        }
        const fetchedCoupons = await this.fetchCoupons([
            ["partner_id", "=", partnerId],
            ["program_id", "=", programId],
        ]);
        const dbCoupon = fetchedCoupons.length > 0 ? fetchedCoupons[0] : null;
        return (
            dbCoupon ||
            this.models["loyalty.card"].create({
                id: loyaltyIdsGenerator(),
                code: null,
                program_id: this.models["loyalty.program"].get(programId),
                partner_id: this.models["res.partner"].get(partnerId),
                points: 0,
                expiration_date: null,
            })
        );
    },
    getLoyaltyCards(partner) {
        const loyaltyCards = [];
        if (this.partnerId2CouponIds[partner.id]) {
            this.partnerId2CouponIds[partner.id].forEach((couponId) =>
                loyaltyCards.push(this.models["loyalty.card"].get(couponId))
            );
        }
        return loyaltyCards;
    },
    /**
     * IMPROVEMENT: It would be better to update the local order object instead of creating a new one.
     *   - This way, we don't need to remember the lines linked to negative coupon ids and relink them after pushing the order.
     */
    async push_single_order(...args) {
        const [orderToPush] = args;

        // Keep some linked records to relink them after pushing the order to the server.
        const lineCouponMap = orderToPush.lines.reduce((agg, line) => {
            if (line.coupon_id && line.coupon_id.id < 0) {
                return { ...agg, [line.uuid]: line.coupon_id.id };
            } else {
                return agg;
            }
        }, {});
        const lineRewardProductMap = orderToPush.lines.reduce((agg, line) => {
            if (line.reward_product_id) {
                return { ...agg, [line.uuid]: line.reward_product_id.id };
            } else {
                return agg;
            }
        }, {});

        const [updatedOrder] = await super.push_single_order(...args);

        // Relink the records.
        for (const line of updatedOrder.lines) {
            if (line.uuid in lineCouponMap) {
                line.update({
                    coupon_id: this.models["loyalty.card"].get(lineCouponMap[line.uuid]),
                });
            }
        }
        for (const line of updatedOrder.lines) {
            if (line.uuid in lineRewardProductMap) {
                line.update({
                    reward_product_id: this.models["product.product"].get(
                        lineRewardProductMap[line.uuid]
                    ),
                });
            }
        }

        return [updatedOrder];
    },
});
