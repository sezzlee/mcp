# Faz 2: okunan Excel verisini aktarma

Status: Phase 2 value transfer is implemented; local acceptance evidence and the A-05 decisions are recorded in the [implementation plan](implementation-plan.md). Formula and formatting copying is required in Phase 3 as F3-09.

## Hedef

Agent, daha önce okunan Excel'den istenen veriyi kendi cevabında yeniden üretmeden bir dosyaya veya sayfaya aktarabilsin.

## Kapsam

| Kimlik | İhtiyaç                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------- |
| F2-01  | Belirli kaynak dosya, sayfa ve hücre aralığındaki içeriği seçmek.                                       |
| F2-02  | Kolon ve koşullarla seçilmiş kayıtları, kullanıcının kastettiği kapsamda aktarmak.                      |
| F2-03  | Gruplandırılmış özet veya analiz sonucunu kaynak kayıtlarından ayrı bir çıktı türü olarak aktarabilmek. |
| F2-04  | Kaynak ve hedef kolonlarını seçmek, sıralamak ve gerektiğinde başlıklara göre eşleştirmek.              |
| F2-05  | Yeni dosyaya, yeni sayfaya veya önceki fazda oluşturulan dosyada desteklenen bir hedefe yerleştirmek.   |
| F2-06  | Sayfalama, örnekleme ve görünür kayıt seçiminin aktarımın tamamlığına etkisini ayırt etmek.             |
| F2-07  | Kaynak ile hedefteki değerlerin anlamını, sıra ve kayıt kapsamını doğrulayabilmek.                      |
| F2-08  | Kaynak dosyayı ve seçilen hedef sürümünü koruyup aktarılmış veriyi yeni çıktı sürümünde sunmak.         |

Phase 2 transfers values only. Formula and formatting copying is required in Phase 3; values/formulas/formatting/all modes remain explicit in that phase. Transpose is deferred. Blank source cells clear occupied targets only with explicit overwrite. Formatted display text, stored values and explicitly interpreted text remain distinct.

## Kodlama iş paketleri

1. Pin the source path, SHA-256 and normalized selection in the replayable transfer reference returned by prepare_transfer; transfer_data materializes it internally without model-generated cell data.
2. Aralık, seçilmiş kayıt kümesi ve analiz sonucunun birbirinden farklı kapsamlarını ele almak.
3. İstenen verinin tamamını, önizleme ve sayfalama sınırlarına takılıp eksiltmeden aktarabilmek.
4. Kolon eşleştirme ve hedef yerleşimini Faz 1'in yazma yetenekleriyle tamamlamak.
5. Aktarım tamlığını, değerleri ve kaynakta değişiklik durumunu doğrulamak.

## Bağımlılıklar ve sınırlar

- Faz 0–1'in kaynak koruma, çıktı sürümü, tür ve toplu yazma ihtiyaçları geçerlidir.
- Kopyalanacak verinin tamamı, agent'a gösterilen önizlemeden bağımsız elde edilebilmelidir; bu belgede teknik aktarım yöntemi seçilmez.
- Kaynak ve hedefte farklı tarih sistemleri varsa aynı takvim tarihini koruma ihtiyacı değerlendirilir.
- Kaynak okuma sırasında değişmiş olabilir; daha önce görülen veriyle güncel veri arasındaki tercih belirlenmelidir.
- İlk okumanın yalnızca görünen satırları seçmesi ile kullanıcının aktarımda görünür kayıt istemesi aynı şey değildir.
- Dışarıdan gelen hedef dosyada değişiklik, Faz 3'ün koruma kapsamına bağlıdır.
- Anahtarla birleştirme ve mevcut kayıtları güncelleme Faz 4'tedir.
- Formülün son kaydedilmiş sonucu, yeniden hesaplanmış güncel sonuç olarak sunulmamalıdır. Sonucu bulunmayan formülün değer aktarımı, sıradan boş hücre gibi gösterilmemelidir. Sunucuda hesaplama Faz 6'dır.

## Kabul senaryoları

- Bir aralık, beklenen başlangıç hücresine doğru satır ve kolonlarla aktarılır.
- Agent yalnızca ilk sonuç sayfasını görmüş olsa da kullanıcı tüm eşleşenleri istediğinde tam kayıt kümesi aktarılır.
- Bilinçli olarak istenen alt küme genişletilmeden taşınır.
- Bir toplu analiz sonucu, kaynak detay kayıtlarıyla karıştırılmadan ayrı sayfaya yazılır.
- Kolon sırası farklı kaynaklar, kararlaştırılmış eşleştirmeyle doğru yerleşir.
- Kaynak değiştiğinde, kayıp veya desteklenmeyen değer bulunduğunda tamamlanma durumu gerçeği yansıtır.
- Kaynak ve önceki hedef sürümü korunur. Aktarım sonucu tam veriyi yeniden yanıtlamak yerine çıktı ve kapsam bilgisini verir.

## Açık kararlar

A-05 was resolved on 2026-10-25: transfer values in Phase 2, copy formulas and formatting in Phase 3, reject changed source versions, transfer all matching rows unless a subset is explicit, and require explicit overwrite for occupied targets. The full behavior and support limits are in the [implementation plan](implementation-plan.md). Sequential simple transfers are supported; keyed joins remain Phase 4.
