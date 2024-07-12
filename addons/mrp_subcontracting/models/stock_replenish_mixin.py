# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import models
from odoo.osv import expression


class ProductReplenishMixin(models.AbstractModel):
    _inherit = 'stock.replenish.mixin'

    def _get_allowed_route_domain(self):
        domains = super()._get_allowed_route_domain()
        return expression.AND([domains, [('id', '!=', self.env.ref('mrp_subcontracting.route_resupply_subcontractor_mto', raise_if_not_found=False).id)]])
