import AppDAO from "../../data/AppDAO.js";
import PromotionTask from "../market/promotion.js";

class CommodityTask {
    static async getCommodityDetails(query) {
        // 根据查询条件放回商品详情

        const query_fields = ["barcode", "pinyin", "name"]
        // 分别从条码、拼音首字母缩写、名称来查询

        const need_fields = "id, barcode, name, unit, size, sale_price, vip_points, is_delete";
        // 前台进行销售时需要的字段

        for (let key of query_fields) {
            const result = await AppDAO.all(`
            SELECT ${need_fields} FROM commodity 
            WHERE ${key}=?
            ;`, query);
            if (result.length !== 0) return result;
            // 精准匹配

            const result_fuzzy = await AppDAO.all(`
            SELECT ${need_fields} FROM commodity 
            WHERE ${key} LIKE ?
            ;`, `%${query}%`);

            if (result_fuzzy.length !== 0) return result_fuzzy;
            // 模糊匹配
        }

        return [];
    }

    static async parseCommodityList(list) {
        // 检查商品是否有参加促销活动的

        const time = new Date().getTime();
        const result = await PromotionTask.checkHasPromotion(time);
        if (!result) {
            return list.map(({ sale_price, vip_points, is_delete, ...keys }) => {
                return {
                    ...keys,
                    vip_points: vip_points === 1,
                    is_delete: is_delete === 1,
                    status: "销售",
                    origin_price: sale_price,
                    sale_price
                }
            });
        } else {
            // { barcode, name, unit, size, sale_price, vip_points, is_delete }
            return await Promise.all(list.map(async ({ id, barcode, sale_price, vip_points, is_delete, ...keys }) => {

                const result = await PromotionTask.getPromotionCommodity(time, id);

                if (!result) {
                    return {
                        ...keys,
                        id,
                        barcode,
                        vip_points: vip_points === 1,
                        is_delete: is_delete === 1,
                        status: "销售",
                        origin_price: sale_price,
                        sale_price
                    }
                }
                const { promotion_type_id, ...args } = result;
                const { key } = await PromotionTask.getPromotionType(promotion_type_id);
                const value = args[key];
                let price = 0;

                console.log(key);
                switch (key) {
                    case "single_discount":
                        price = sale_price * value;
                        break;
                    case "single_off_price":
                        price = value;
                        break;
                    default:
                        price = sale_price;
                        break;
                }

                return {
                    ...keys,
                    id,
                    barcode,
                    vip_points: vip_points === 1,
                    is_delete: is_delete === 1,
                    status: "促销",
                    promotion_type: key,
                    value,
                    origin_price: sale_price,
                    sale_price: price
                }
            }));
        }
    }
}

export default CommodityTask;