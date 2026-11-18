# 收件服务接口

人工资料接收保持兼容。POST /intakes 的 JSON 字段为 collectionId、sourceKey、revision、mediaType、contentBase64；返回 receiptId、sha256、byteLength 和轻量 summary。相同资料集、来源键与修订对应同一收件，字节不同返回 409。GET /receipts/{receiptId} 可读元数据，GET /receipts/{receiptId}/body 返回原字节。

POST /acquisitions 接受 collectionId、entry 和可选 options，entry 是授权来源完整地址。若 entry 是捐赠包清单（JSON，含 deliveryId 与 roots），服务会把清单与包内全部 resources 逐个领取为独立收件，然后基于包内原文自动解释；返回 collectionId、deliveryId、receiptIds 和当前 issue 数。自动解释沿用此入口，所有自动取得的依赖也保留真实原文收件，不用人工造 records 代替自动接入。options.deliveryId 可把补交资料并入已登记的同一捐赠包，并触发整包重新解释；清单中的 deliveryId 与 options 不一致时返回 409。来源访问只限启动时冻结的 origin，不能访问其他主机或执行交付件。

GET /collections 返回资料集列表，GET /collections/{collectionId} 返回 collectionId、receiptIds、deliveries、records、issues；人工登记过对应关系时另有 identities。结构化 records 的每项包含 kind、key、value、provenance、deliveryId；key 由各来源身份语义决定，不要求特定内部编码。provenance 是含 receiptId 与 location 的数组，location 可采用字节区间、原行列、JSON Pointer 等可复查定位。issues 每项包含 reason、location，至少能说明原因、受影响范围和已有来源依据，不能用静默丢弃表示未知。缺失资料不等于来源明确删除。

同一身份在新版本中内容变化时，records 保留 `revisions` 历史；本次来源版本未再产生的记录标为 `current: false` 并附 `not_in_current_source` issue，不静默删除。自动解释的 issues 按 deliveryId 刷新，人工问题不受影响。若人工记录（`manual: true`）与自动解释共用同一 kind/key，人工值优先保留，自动值与此前的 issue 记入 `conflicts` 数组并附 `manual_identity_conflict` issue，直到馆员处理。

POST /collections/{collectionId}/records 可录入人工确认记录，必须附本资料集的真实收件出处。自动接入不能依赖操作者事先写入答案。该接口目前采用同键不可变约定；新增版本、历史记录与当前视图如何协调，应与来源语义相符，不能覆盖已归档原文。来源契约中的值是查询视图契约，不限定解析器、状态机或索引的内部实现。

POST /collections/{collectionId}/identities 接受 { left, right, confirmedBy? }，登记整理员确认的跨包人物对应关系（值为记录 key，如 delivery-1:@I1@）。两侧必须是本资料集已解释的 `person` key 且不相同；同一对关系不分左右只登记一次，重复提交保持幂等。该接口只登记对应，不合并人物记录、不改变任何原始出处。

本地 provider 是独立 HTTP 来源，fixtures 为合成的公开样本，不包含真实个人或机构凭据。fixtures/descriptor.json 说明来源入口与接入选项。多数资料源用 /deliveries 声明 deliveryId、revision、roots 和 resources；roots 是需处理的独立入口，resources 是同包可领取资源，不是公网搜索指令。文件可用 GET、HEAD 与单段 Range 读取；ETag 表示返回字节的身份。SOURCE_STAGE=partial 启动不完整交付状态，完整状态是默认值。来源服务不接受写操作。
