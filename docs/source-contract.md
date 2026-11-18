# 来源资料契约

接收 GEDCOM 7 层级行，UTF-8，支持 INDI/FAM/SOUR/NOTE、事件、指针、CONT/CONC 续行、姓名、扩展标签及日期原文。delivery 中的 family.ged 与 sources.ged 是同一捐赠包的拆分导出，指针作用域为 deliveryId；独立资料集不互认指针。relationship value 使用 child、family、pedigree；person 以 pointer 保留身份；event-date 以原文和 precision 保存，不将约数改成精确日。日期范围、限定符与未知扩展不要求推理，引用缺失时记录 issue。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。

## 记录身份

- `person`、`family`、`source` 以 `deliveryId + pointer` 为身份，`key` 形如 `delivery-1:@I1@`。同名人物只要指针不同就是两条记录，绝不按姓名合并。
- 同一包内同一声明指针出现多次时，每份声明都保留，后出现的以 `#2`、`#3` 区分，并登记 `duplicate_pointer` issue；哪份有效留给整理员判断。
- 不同捐赠包中相同的指针文本（例如两个包都有 `@I1@`）仍是不同身份。资料集内可用 `POST /collections/{collectionId}/identities` 登记人工确认的对应关系，登记只表示“可能是同一人”，不合并、不删除任何原始记录。
- 记录都带 `deliveryId`；自动解释的记录在重新领取后会就地更新 `value`/`provenance`，旧值留在 `revisions` 中。本次来源版本不再产生的记录标为 `current: false` 并附 `not_in_current_source` issue，不静默删除。

## 关系与限定

- 个人 `FAMC` 生成 `relationship`，值含 `child`、`family`，解析成功时附 `familyKey`。
- 只有来源明确写出 `PEDI` 时才保存 `pedigree`（如 `FOSTER`、`ADOPTED`）。未写 `PEDI` 时不补写生物学关系，也不作默认推断。
- `FAMC` 下的 `NOTE` 生成为 `note`，附 `relationship` 指回该关系记录；共享注释指针另附 `noteKey`。
- `FAM` 的 `CHIL` 若在个人侧已有对应 `FAMC`，不重复生成关系；仅家庭侧声明时生成 `relationship`，值含 `child`、`family`，并在解析成功时附 `childKey`、`familyKey`。
- `HUSB`/`WIFE`/`FAMS` 以普通 `tag` 记录保留指针，不推断婚姻或亲子类型。

## 日期

`event-date` 的 `raw` 保存原始日期，`precision` 说明表达方式：

| precision | 例子 |
| --- | --- |
| `range` | `BET 1900 AND 1902`、`FROM 1900 TO 1902` |
| `about` | `ABT 1888`、`CIRCA 1888` |
| `estimated` / `calculated` | `EST 1888`、`CAL 1888` |
| `before` / `after` | `BEF 1888`、`AFT 1888` |
| `phrase` | `INT ...`、括号短语 |
| `year` / `month` / `day` | 对应粒度的具体日期 |
| `unknown` | 无法归类的表达式 |

`precision` 只描述原文，不产生新的精确日期。空 `DATE` 登记 `empty_date` issue。

## 续行、自定义标签与未解释内容

- `CONT` 表示换行、`CONC` 表示直接拼接，都会并入父节点值；父节点 provenance 的 `location` 覆盖 `line:首行-末行`，续行明细另存于 `continuations`。
- 以 `_` 开头的标签生成为 `custom-tag`，完整保留标签名与值，不当作标准语义解释。
- 未被专门解释的标准标签生成为 `tag`（`tag`、`value`，指针形式时附 `pointer`），保留原层级位置，不宣称已解释。
- 无法解析的行、层级错位、孤立续行、缺少 `TRLR` 都登记 issue，包含 `reason`、`location`、`receiptId`。

## 出处与补交

- 每条记录、每个 issue 都带本资料集的真实 `receiptId` 与 `location`（行号或行号区间），可经 `GET /receipts/{receiptId}/body` 复查原始字节。
- 捐赠包清单收件与每个资源收件分别保存；清单本身不作为 GEDCOM 解释。
- 资源缺失或暂时不可取时登记 `resource_unavailable`，包内其余资料照常解释。
- 补交资料可再次 `POST /acquisitions`，以 `options.deliveryId` 并入原包；服务会基于该包全部已领取原文重新解释，原先无法解析的指针（如 `@S1@`）会补齐 `sourceKey`，相关 issue 随之消失，已归档原文不会被覆盖。
- 同一地址有多个历史修订时，当前解释使用最新领取的版本；旧修订收件仍保留可查。
- 未解析的指针登记 `unresolved_pointer`；指针类型不符登记 `pointer_type_mismatch`。跨包指针不解析，也不跨包猜测。

## 人工确认

缺失资料不等于来源明确删除。自动解释不依赖操作者事先写入答案；人工可用 `POST /collections/{collectionId}/records` 补充带真实收件出处的确认记录，用 `POST /collections/{collectionId}/identities` 记录跨包人物对应关系。
