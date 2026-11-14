# 来源资料契约

接收 GEDCOM 7 层级行，UTF-8，支持 INDI/FAM/SOUR/NOTE、事件、指针、CONT、姓名及日期原文。delivery 中的 family.ged 与 sources.ged 是同一捐赠包的拆分导出，指针作用域为 deliveryId；独立资料集不互认指针。relationship value 使用 child、family、pedigree；person 以 pointer 保留身份；event-date 以原文和 precision 保存，不将约数改成精确日。日期范围、限定符与未知扩展不要求推理，引用缺失时记录 issue。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。

event-date 的 raw 保存原始日期，precision=range 表示 BET/AND 的区间声明。
