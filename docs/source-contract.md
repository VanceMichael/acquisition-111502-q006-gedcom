# 来源资料契约

接收 GEDCOM 7 层级行，UTF-8，支持 INDI/FAM/SOUR/NOTE、事件、指针、CONT/CONC、姓名及日期原文。delivery 中的 family.ged 与 sources.ged 是同一捐赠包的拆分导出，指针作用域为 deliveryId，在同包各资源间统一解析；独立资料集不互认指针。relationship value 使用 child、family、pedigree；person 以 pointer 保留身份；event-date 以原文和 precision 保存，不将约数改成精确日。日期范围、限定符与未知扩展不要求推理，引用缺失时记录 issue。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。

event-date 的 raw 保存原始日期，precision=range 表示 BET/AND 的区间声明。

## 结构化接入的身份与保真规则

- 记录 key 以 `deliveryId` 为前缀（如 `delivery-1:person:@I1@`），人物、家庭、出处、注释的包内身份来自指针而非姓名。两个捐赠包即使出现相同指针或同名人物，也产生不同 key，不会自动合并；跨包是否同一人留给整理员通过人工记录接口确认。
- relationship 由 FAMC（含 PEDI 限定）与 FAM 的 CHIL 对账生成。PEDI 原文（如 FOSTER）跟随保存；来源未声明 PEDI 时 pedigree 为 null，表示未声明，绝不默认生物学关系。
- event-date 同时保留 raw 原文与 precision：range（BET/AND）、period（FROM/TO）、approximate（ABT）、calculated（CAL）、estimated（EST）、boundary（BEF/AFT）、phrase（括注短语）、exact。约数与区间不被折算成精确日期。
- 每条记录带 statement 递归快照与每个物理行的 location（`资源名:line:行号`），CONT/CONC 续行、自定义标签（下划线标签）与重复声明均原样保留，可沿任一关系回到原记录。
- 同包内无法解析的指针、缺件、截断（缺 0 TRLR）、未知 0 级标签都写入 issues，注明 reason、location 与已有来源依据；缺失资料不等于来源明确删除。
- 来源补交的 SOUR 记录进入同一 deliveryId 后即可补齐此前的出处引用；自动接入只解释真实领取并登记收件的字节。
