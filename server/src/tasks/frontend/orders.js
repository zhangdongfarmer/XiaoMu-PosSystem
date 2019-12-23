import AppDAO from "../../data/AppDAO.js";
import { math } from "../../lib/mathc.js";
import { getNightTimeStrap } from "../../lib/time.js";
import CommodityTask from "../commodity.js";
import UserTask from "../users.js";
import VipTask from "../vip.js";
import { validateAdmin } from "../../middleware/admin.js";

let is_first_create = true;

class OrdersTask {

    static async validChange(client_pay, change, sale_price) {
        const result = math.subtract(client_pay, change);
        return sale_price === result;
    }

    static async validOrderPrice(price, list) {
        // 验证前台提交的商品总价格和商品实际价格是否相符合

        const result = math.addList(list.map(({ sale_price, count }) => math.multiply(sale_price, count)));

        return result === price;
    }

    static async getSerialNumberCount(timestamp) {
        if (timestamp) {

            const { "count(*)": count } = await AppDAO.get(`
            SELECT count(*) FROM serial_number WHERE timestamp >= ?
            ;`, timestamp);
            return count;
        } else {
            const { "count(*)": count } = await AppDAO.get(`
            SELECT count(*) FROM serial_number
            ;`);
            return count;
        }
    }

    static async clearSerialNumberTable() {
        return await AppDAO.run(`
        DELETE FROM serial_number
        ;`);
    }

    static async createSerialNumber(year, month, day, timestamp) {

        if (is_first_create) {
            // 今日第一次打开创建流水号时

            const midnight = new Date(`${year}/${month}/${day}`).getTime();
            const count = await this.getSerialNumberCount(midnight);
            // 大于今天凌晨00：00的所有流水号数量

            if (count === 0) {
                // 当没有创建过流水号时

                await this.clearSerialNumberTable();
                // 清空昨天的流水号

            }

            is_first_create = false;
        }

        await AppDAO.run(`
        INSERT INTO serial_number 
        (timestamp) 
        VALUES (?)
        ;`, timestamp);
        // 插入一条新的记录

        const num = String(await this.getSerialNumberCount());
        return "0".repeat(4 - num.length) + num;
    }

    static async createOrderID() {
        // 生成订单编号

        function format(n) {
            const str = String(n);
            return str.length === 1 ? "0" + str : str;
        }

        const time = new Date();
        const timestamp = time.getTime();
        const year = time.getFullYear();
        const month = time.getMonth() + 1;
        const day = time.getDate();

        const serial_number = await this.createSerialNumber(year, month, day, timestamp);
        const order_id = `${String(year).slice(2)}${format(month)}${format(day)}${String(timestamp).slice(5, 10)}${serial_number}`;
        return [order_id, timestamp];
    }

    static async getVipPointsScale() {
        const { money, point } = await AppDAO.get(`
        SELECT money, point FROM vip_score_rules;
        ;`);
        return point / money;
    }

    static async handleOrder({ origin_price, sale_price, commodity_list, vip_code, username,
        pay_type,
        client_pay,
        change }) {
        // 保存订单信息


        let in_price_list = [], point_money_list = [];
        let commodity_list_details = [];
        // 保存订单所需的数据

        const isAdmin = await validateAdmin(username);

        for (let { barcode, sale_price, count, ...args } of commodity_list) {
            const result = await CommodityTask.getCommodityDetails(barcode);
            if (!result) return {
                status: false,
                data: `条码为${barcode}的商品不存在!`
            }

            const { id, vip_points, in_price, name, is_delete, sale_price: _sale_price } = result;

            if (!isAdmin) {
                if (sale_price !== _sale_price) return {
                    static: false,
                    data: `条码为${barcode}的商品价格不正确!`
                }
            }

            if (is_delete === 1) return {
                status: false,
                data: `条码为${barcode}的${name}已被禁用!`
            }

            if (vip_points === 1) {
                point_money_list.push(math.multiply(sale_price, count));
            }
            in_price_list.push(math.multiply(in_price, count));

            commodity_list_details.push({
                commodity_id: id,
                barcode,
                sale_price,
                origin_price: in_price,
                count,
                ...args
            });
        }

        const scale = await this.getVipPointsScale();
        // 商品积分比例

        const in_price_sum = math.addList(in_price_list);
        // 本订单商品进价

        const point_money_sum = math.addList(point_money_list);
        // 本订单可积分的商品总售价

        const points = math.round(math.multiply(point_money_sum, scale));
        // 本单积分

        const profit = math.subtract(sale_price, in_price_sum);
        // 本订单利润

        const [order_id, timestamp] = await this.createOrderID();
        // 订单号和时间戳


        const { id: user_id } = await UserTask.getUserDetails(username);


        if (vip_code) {
            await VipTask.vipConsumeAddPoints(vip_code, points, sale_price);
        }


        await this.saveOrder({
            order_id,
            check_date: timestamp,
            sale_price,
            sale_origin_price: origin_price,
            in_price: in_price_sum,
            profit,
            vip_code,
            points,
            user_id,
            pay_type,
            client_pay,
            change
        });

        await this.saveOrderDetails(order_id, commodity_list_details);

        const data = await this.getOrderAllDetails(order_id);

        return {
            status: true,
            data
        }
    }

    static async getOrderAllDetails(order_id) {
        // 获取订单的所有信息

        const result = await this.getTodayOrders(null, order_id);

        if (!result) return undefined;

        const commodity_data = await Promise.all((await this.getOrderDetails(order_id))
            .map(async ({ id, order_id, commodity_id, ...args }) => {
                const { name } = await CommodityTask.getCommodityDetailsByTimestamp(result.check_date, commodity_id, "id");
                return {
                    name,
                    ...args
                }
            }));
        return {
            ...result,
            commodity_list: commodity_data
        }
    }

    static async saveOrderDetails(order_id, commodity_list_details) {
        // 保存订单详细信息

        return await Promise.all(commodity_list_details.map(async args => {
            const fields = ["order_id"];
            const params = [order_id];
            const keys = Object.keys(args);
            for (let key of keys) {
                fields.push(key);
                params.push(args[key]);
            }

            return await AppDAO.run(`
                INSERT INTO order_details 
                (${fields.join(", ")}) 
                VALUES (?${", ?".repeat(params.length - 1)})
            ;`, params);
        }));
    }

    static async saveOrder({
        order_id,
        check_date,
        sale_price,
        sale_origin_price,
        in_price,
        profit,
        vip_code,
        client_pay,
        change,
        pay_type,
        user_id,
        points
    }) {
        // 保存订单信息

        const fields = [
            "order_id",
            "check_date",
            "sale_price",
            "sale_origin_price",
            "in_price",
            "profit",
            "client_pay",
            "change",
            "pay_type",
            "user_id",
            "points"
        ];

        const args = [
            order_id,
            check_date,
            sale_price,
            sale_origin_price,
            in_price,
            profit,
            client_pay,
            change,
            pay_type,
            user_id,
            points
        ];

        if (vip_code) {
            const { vip_sum } = await VipTask.getVipCurrentValue(vip_code);
            fields.push("vip_code");
            fields.push("current_point");
            args.push(vip_code);
            args.push(vip_sum);
        }
        return await AppDAO.run(`
        INSERT INTO orders 
        (${fields.join(", ")}) 
        VALUES (?${", ?".repeat(args.length - 1)})
        ;`, args);
    }

    static async getTodayOrders(username, order_id) {
        // 当传入username获取今日指定用户所操作的订单
        // 当传入order_id时获取指定订单的信息
        // 两参数二选一


        if (order_id) {
            return await AppDAO.get(`
        SELECT order_id, check_date, sale_origin_price, sale_price, vip_code, client_pay, change, user_id, is_undo, pay_type, points, current_point 
        FROM orders 
        WHERE order_id=?
        ;`, order_id);
        }


        const { id } = await UserTask.getUserDetails(username);
        const timestamp = getNightTimeStrap();
        return await AppDAO.all(`
        SELECT order_id, check_date, sale_origin_price, sale_price, vip_code, client_pay, change, user_id, is_undo, pay_type, points, current_point 
        FROM orders 
        WHERE (user_id = ? AND check_date >= ?)
        ;`, [id, timestamp]);
    }

    static async getOrderDetails(order_id) {
        return await AppDAO.all(`
        SELECT * FROM order_details WHERE order_id=?
        ;`, order_id);
    }

    static async undoOrder(order_id, vip_code, points, sale_price) {
        // 撤销订单

        if (vip_code) {
            await VipTask.undoOrderMinusVipPoints(vip_code, points, sale_price);

        }
        return await AppDAO.run(`
        UPDATE orders SET 
        is_undo=1 
        WHERE order_id=?
        ;`, order_id);

    }

    static async addVipToOrder(order_id, vip_code, points, sale_price) {
        // 向订单追加积分

        await VipTask.vipConsumeAddPoints(vip_code, points, sale_price);
        const { vip_sum } = await VipTask.getVipCurrentValue(vip_code);

        return await AppDAO.run(`
        UPDATE orders SET
        vip_code=?, current_point=? 
        WHERE order_id=?
        ;`, [vip_code, vip_sum, order_id]);
    }
}

export default OrdersTask;