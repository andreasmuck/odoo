import { CashMovePopup } from "@point_of_sale/app/navbar/cash_move_popup/cash_move_popup";
import { patch } from "@web/core/utils/patch";

patch(CashMovePopup.prototype, {
    _prepare_try_cash_in_out_payload() {
        const result = super._prepare_try_cash_in_out_payload(...arguments);
        const employee_id = this.pos.get_cashier().id;
        // replace the extras with an object containing "employee_id"
        result[result.length - 1] = { ...result[result.length - 1], employee_id };
        return result;
    },
});
