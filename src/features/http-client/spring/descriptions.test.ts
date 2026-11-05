import { expect, it } from "vitest";
import { springControllers } from "./endpoints";

it("reads Swagger/OpenAPI names before documentation and keeps method source positions", () => {
  const source = `/** Controller comment */
@Tag(name = "订单管理")
@RestController
class OrderController {
  /** Gets an order. */
  @Operation(summary = "查询订单")
  @GetMapping("/orders/{id}")
  public Order find() { return null; }
  /** Creates an order.
   * @param body request
   */
  @PostMapping("/orders")
  public Order save(@RequestBody Order body) { return body; }
}`;
  const [controller] = springControllers(source);
  expect(controller?.summary).toBe("订单管理");
  expect(controller?.endpoints.map((endpoint) => endpoint.summary)).toEqual(["查询订单", "Creates an order."]);
  expect(source.slice(controller!.endpoints[0]!.offset)).toMatch(/^find\(/);
});

it("reads legacy Swagger names and Kotlin documentation without treating tags as titles", () => {
  const [java] = springControllers(`@Api(tags = {"设备管理"}) @RestController class DeviceController {
    @ApiOperation(value = "设备列表") @GetMapping("/devices") Object list() { return null; }
  }`);
  expect(java?.summary).toBe("设备管理");
  expect(java?.endpoints[0]?.summary).toBe("设备列表");
  const [kotlin] = springControllers(`@RestController class HealthController {
    /** Read current health.
     * @return status
     */
    @GetMapping("/health")
    fun health(): String = "ok"
  }`);
  expect(kotlin?.endpoints[0]?.summary).toBe("Read current health.");
});
